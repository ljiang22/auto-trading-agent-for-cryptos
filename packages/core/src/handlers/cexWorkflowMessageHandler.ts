/**
 * Trading Info Message Handler (CEX) using a Regular-like LangGraph workflow:
 * - LLM loop with action calling
 * - Parameter sufficiency check (ask narrative questions when missing)
 * - Human-in-the-loop parameter review with double confirmation
 * - Action execution, then LLM formats results, then UI modal event
 */

import { v4 as uuidv4 } from "uuid";
import { StateGraph, Annotation } from "@langchain/langgraph";

import { z } from "zod";

import { elizaLogger } from "../utils/logger.ts";
import { stringToUuid } from "../utils/uuid.ts";
import { generateObject, generateText } from "../ai/generation.ts";
import { composeContextSplit, addHeader } from "../core/context.ts";
import {
    getCEXFinalResponseTemplate,
    getCEXMessageTemplate,
    getCEXResultFormattingTemplate,
    getCEXAuthRequiredErrorTemplate,
    getCEXTradingNotEnabledErrorTemplate,
    getCEXDefaultExchangeRequiredErrorTemplate,
} from "../templates/cexMessageTemplate.ts";
import { getCexPlanAsTextTemplate } from "../templates/cexPlanAsTextTemplate.ts";
import { getDataRetentionConfig, DATA_RETENTION_DAYS_BY_TIER } from "../utils/dataRetention.ts";
import { buildLangSmithRunnableConfig } from "../utils/langsmith.ts";
import {
    setDecisionOutcome,
    spanFromProcessingStep,
    withSpan,
} from "../utils/tracing.ts";
import type {
    Action,
    Content,
    HandlerCallback,
    IAgentRuntime,
    ITradingReconciliationService,
    Memory,
    ProcessingStep,
    State,
    StreamingCallback,
    UUID,
    ExchangeAuths,
    DefaultExchangeAuth,
    CEXActionSchema,
    CEXSpecProvider,
} from "../core/types.ts";
import { ModelClass, ServiceType } from "../core/types.ts";

import { getCEXActions } from "../utils/pluginFilter.ts";
import { getLanguageInstruction, type Locale } from "../utils/languageUtils.ts";
export type {
    HumanInputRequestPayload,
    HumanInputDecision,
    HumanInputFieldSchema,
    PendingHumanInputEntry,
} from "./humanInputState.ts";
import {
    resolvePendingHumanInputApproval,
    waitForHumanInputApproval,
    type HumanInputDecision,
} from "./humanInputState.ts";
import {
    inferStakeHint,
    preprocess as cexPreprocess,
    type CexPreprocessOutput,
} from "./cexRequestPreprocess.ts";
import {
    classifyStake,
    isReadOnlyStake,
    type Stake,
} from "./cexWorkflowStakeClassifier.ts";
import { findVenueMentionInText, matchVenueToken } from "./cexVenueAliases.ts";
import type { ExchangeResolution } from "./exchangeResolver.ts";
import {
    renderExchangeClarification,
    renderExchangeNotConfiguredMessage,
} from "../templates/cexClarificationTemplate.ts";
import { CEX_WORKFLOW_STEPS } from "./cexWorkflowSteps.ts";
import { intentClassForAction } from "../utils/cexBypassPredicate.ts";
import { attachResponseSummary } from "../utils/persistResponseSummary.ts";
import { runPlanModeIfApplicable } from "./cexPlanRunner.ts";
import { formatPendingTradingPlansContext } from "./pendingPlanContext.ts";
import {
    buildDedupContext,
    buildDedupExistingOrderSummary,
    dedupApprovalDescription,
    dedupApprovalTitleForKind,
    dedupDeclinedMessage,
    type DedupKind,
} from "./cexDedupApproval.ts";

const MAX_DEDUP_OVERRIDE_ATTEMPTS = 3;
import {
    buildMarketSnapshot,
    resolveBinanceSymbol,
    type MarketSnapshotResult,
} from "./cexMarketSnapshot.ts";
import {
    getApprovalRequestCopy,
    getOrderSubmitCopy,
    getRiskCheckCopy,
} from "./cexStreamMessages.ts";
import {
    classifyPromptInjection,
    renderPromptInjectionDowngradeNotice,
} from "../utils/promptInjectionDefense.ts";
import { LIVE_TRADING_GLOBAL_KILL_REASON, isLiveTradingGlobalKillActive } from "../utils/liveTradingGlobalKill.ts";
import { isPublicAccessModeActive } from "../utils/publicAccessMode.ts";
import {
    buildUserError,
    renderUserErrorMarkdown,
    type UserErrorCode,
} from "../utils/userFacingError.ts";

const cexFormattedResultEnvelopeSchema = z.object({
    response: z.string(),
});

/**
 * Walk a JSON-shaped text and escape literal control characters (`\n`,
 * `\r`, `\t`) that appear *inside* a double-quoted string value. LLMs
 * frequently emit `{ "response": "...multi-line markdown..." }` with
 * raw newlines, which `JSON.parse` rejects ("Bad control character in
 * string literal"). Tightening the prompt to demand strict escaping
 * is unreliable across model classes, so we recover at the parse site.
 *
 * Important: only modifies text *inside* string values. Whitespace
 * between tokens (outside strings) is preserved untouched. Existing
 * valid escape sequences (`\\n`, `\\"`, `\\\\`) are passed through
 * unchanged.
 */
export function escapeUnescapedControlCharsInJsonStrings(source: string): string {
    let out = "";
    let inString = false;
    let escape = false;
    for (let i = 0; i < source.length; i++) {
        const c = source[i]!;
        if (escape) {
            out += c;
            escape = false;
            continue;
        }
        if (inString) {
            if (c === "\\") {
                out += c;
                escape = true;
                continue;
            }
            if (c === '"') {
                inString = false;
                out += c;
                continue;
            }
            if (c === "\n") {
                out += "\\n";
                continue;
            }
            if (c === "\r") {
                out += "\\r";
                continue;
            }
            if (c === "\t") {
                out += "\\t";
                continue;
            }
            out += c;
            continue;
        }
        if (c === '"') {
            inString = true;
        }
        out += c;
    }
    return out;
}

/**
 * After an optional ``` / ```json fence, extract the first top-level `{ ... }` span using
 * brace depth while respecting JSON double-quoted strings (so ``` inside a string value
 * does not truncate the object).
 */
export function extractFirstBalancedJsonObject(source: string): string | null {
    const start = source.indexOf("{");
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < source.length; i++) {
        const c = source[i]!;
        if (escape) {
            escape = false;
            continue;
        }
        if (inString) {
            if (c === "\\") {
                escape = true;
                continue;
            }
            if (c === '"') {
                inString = false;
            }
            continue;
        }
        if (c === '"') {
            inString = true;
            continue;
        }
        if (c === "{") {
            depth++;
        } else if (c === "}") {
            depth--;
            if (depth === 0) {
                return source.slice(start, i + 1);
            }
        }
    }
    return null;
}

/**
 * Lenient JSON string unescape: decodes the standard JSON escapes and, for
 * unrecognized escapes the model sometimes emits inside markdown (e.g. a
 * markdown-escaped `\$`), drops the backslash and keeps the character so the
 * rendered text reads naturally.
 */
export function lenientUnescapeJsonString(value: string): string {
    return value.replace(/\\(u[0-9a-fA-F]{4}|[\s\S])/g, (_m, esc: string) => {
        switch (esc[0]) {
            case '"':
                return '"';
            case "\\":
                return "\\";
            case "/":
                return "/";
            case "b":
                return "\b";
            case "f":
                return "\f";
            case "n":
                return "\n";
            case "r":
                return "\r";
            case "t":
                return "\t";
            case "u":
                return String.fromCharCode(Number.parseInt(esc.slice(1), 16));
            default:
                return esc; // unknown escape (e.g. \$) → drop the backslash
        }
    });
}

/**
 * Last-resort, JSON.parse-free extraction of the `response` field from a
 * `{ "response": "<markdown>" }` envelope. Anchors on the field key and the
 * envelope's trailing `}` instead of parsing, so it recovers the markdown
 * even when the body contains invalid JSON escapes (e.g. `\$1000`) or
 * unescaped interior double-quotes that defeat `JSON.parse`. Returns null
 * when no `response` envelope is present, so genuine plain-text replies pass
 * through to the caller unchanged.
 */
export function extractResponseFieldLenient(raw: string): string | null {
    if (!raw) return null;
    let t = raw.trim();
    // Strip a leading ``` / ```json fence and a trailing ``` fence, if present.
    t = t
        .replace(/^```(?:json)?[ \t]*\r?\n?/i, "")
        .replace(/\r?\n?```$/i, "")
        .trim();

    const keyMatch = t.match(/"response"[ \t]*:[ \t]*"/);
    if (!keyMatch || keyMatch.index === undefined) return null;
    const valStart = keyMatch.index + keyMatch[0].length;

    const lastBrace = t.lastIndexOf("}");
    if (lastBrace < valStart) return null;

    const between = t.slice(valStart, lastBrace);
    const lastQuote = between.lastIndexOf('"');
    if (lastQuote < 0) return null;

    return lenientUnescapeJsonString(between.slice(0, lastQuote));
}

/**
 * Parses markdown JSON from the LLM per `cexMessageTemplate.ts`:
 * - Option A: `{ "action", "parameters" }` inside ``` / ```json
 * - Result / final: `{ "response": "..." }` inside ``` / ```json
 *
 * `action_or_response`: each fenced segment in document order; first object with non-empty
 * `action` wins, else first with `response`.
 *
 * `response_only`: fenced segments **last to first** (avoids a stray earlier fence shadowing the
 * real envelope), then a bare balanced `{...}` on the full trimmed string.
 */
function parseCexMarkdownJsonContract(
    raw: string,
    mode: "action_or_response" | "response_only"
): Record<string, unknown> | null {
    const t = raw.trim();
    const fenceRe = /\n?\s*```(?:json)?\s*\n?/gi;
    const fencedBodies: string[] = [];
    for (let m = fenceRe.exec(t); m !== null; m = fenceRe.exec(t)) {
        fencedBodies.push(t.slice(m.index + m[0].length).trim());
    }

    // Try strict JSON.parse first; on failure, retry with the tolerant
    // control-char escaper. This recovers from the common LLM mistake of
    // emitting raw newlines inside the `response` value (e.g., a multi-row
    // markdown trading report after batch cancel).
    const parseTolerant = (slice: string): unknown | undefined => {
        try {
            return JSON.parse(slice);
        } catch {
            try {
                return JSON.parse(escapeUnescapedControlCharsInJsonStrings(slice));
            } catch {
                return undefined;
            }
        }
    };

    const tryBodies = (bodies: string[]): Record<string, unknown> | null => {
        for (const body of bodies) {
            const slice = extractFirstBalancedJsonObject(body);
            if (!slice) continue;
            const parsed = parseTolerant(slice);
            if (!parsed || typeof parsed !== "object") continue;
            const o = parsed as Record<string, unknown>;
            if (mode === "response_only") {
                if ("response" in o) return o;
                continue;
            }
            if (typeof o.action === "string" && o.action.length > 0) {
                return o;
            }
            if ("response" in o) {
                return o;
            }
        }
        return null;
    };

    if (fencedBodies.length > 0) {
        const ordered =
            mode === "response_only" ? [...fencedBodies].reverse() : fencedBodies;
        const hit = tryBodies(ordered);
        if (hit) return hit;
    }

    const slice = extractFirstBalancedJsonObject(t);
    if (slice) {
        const parsed = parseTolerant(slice);
        if (parsed && typeof parsed === "object") {
            const o = parsed as Record<string, unknown>;
            if (mode === "response_only") {
                if ("response" in o) return o;
            } else {
                if (typeof o.action === "string" && o.action.length > 0) return o;
                if ("response" in o) return o;
            }
        }
    }

    // Last resort: recover a `{ "response": "<markdown>" }` envelope whose body
    // carries invalid JSON escapes (e.g. `\$1000`) or unescaped interior quotes
    // that defeat parseTolerant. Returns the markdown directly; genuine
    // non-envelope text (no `response` key) still falls through to null so the
    // caller keeps the raw reply.
    const lenientResponse = extractResponseFieldLenient(t);
    return lenientResponse !== null ? { response: lenientResponse } : null;
}

function cexUnknownResponseToDisplayText(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    if (value !== null && typeof value === "object") {
        return JSON.stringify(value, null, 2);
    }
    return undefined;
}

/**
 * Parses CEX result-formatting LLM output into user-facing markdown/text.
 * Used when falling back from structured `generateObject` or for legacy model output.
 */
export function parseCexFormattedResultEnvelope(raw: string): string {
    const rec = parseCexMarkdownJsonContract(raw, "response_only");
    if (rec) {
        const text = cexUnknownResponseToDisplayText(rec.response);
        if (text !== undefined) {
            return text;
        }
    }
    elizaLogger.debug(
        "[CEXWorkflow] formatted result envelope: no `{ \"response\": ... }` contract; using raw text"
    );
    return raw.trim();
}

export function resolvePendingCEXWorkflowApproval(
    runtime: IAgentRuntime,
    threadId: string,
    decision: HumanInputDecision,
    approvalId?: string
): boolean {
    return resolvePendingHumanInputApproval(runtime, threadId, decision, approvalId);
}

/**
 * F1 — render the user-facing paper/shadow disclosure badge. Locale-aware
 * so zh-CN users see the same warning in Chinese. Live mode emits an empty
 * string (no badge).
 */
export function renderModeBadge(
    mode: "live" | "paper" | "shadow",
    locale: Locale,
): string {
    if (mode === "live") return "";
    if (mode === "paper") {
        return locale === "zh-CN"
            ? "**[模拟交易 — 无真实资金]**"
            : "**[PAPER MODE — no real money]**";
    }
    // shadow
    return locale === "zh-CN"
        ? "**[影子交易 — 仅记录，未下单]**"
        : "**[SHADOW MODE — hypothetical, not executed]**";
}

/**
 * F1 — mechanical post-check that the formatter calls before returning.
 * The formatter prompt asks the SLM to emit the paper/shadow badge on
 * the first line, but we cannot trust an SLM to follow that 100% of
 * the time. If the badge is absent AND the mode is non-live, prefix
 * it deterministically. Live mode is a no-op.
 *
 * This is the safety net for the QA C1 hallucination ("placed on
 * Binance" said about a paper order).
 *
 * Extracted from `generateFormattedResult` so the post-check has a
 * dedicated unit test (e2e against the actual handler is hard to wire
 * because the formatter calls `generateObject` which needs a real
 * LLM provider — the helper here gets the exact same input + output).
 */
export function applyMechanicalModeBadge(
    displayText: string,
    mode: "live" | "paper" | "shadow",
    locale: Locale,
): string {
    if (mode === "live") return displayText;
    if (hasModeBadge(displayText, mode)) return displayText;
    const badge = renderModeBadge(mode, locale);
    elizaLogger.info(
        `[CEXWorkflow] F1 mechanical badge applied (mode=${mode}); formatter omitted it`,
    );
    return `${badge}\n\n${displayText}`;
}

/**
 * F1 — detect whether a formatter output already starts with the
 * disclosure badge for the given mode. Used by the mechanical
 * post-check that prepends the badge when the SLM forgets it.
 *
 * Lenient: matches the canonical English / Chinese forms AND a few
 * common LLM paraphrases (case-insensitive). We err on the side of
 * NOT prefixing twice over forcing a strict literal — the badge is
 * the contract, not the exact ASCII.
 */
export function hasModeBadge(
    text: string,
    mode: "live" | "paper" | "shadow",
): boolean {
    if (mode === "live") return true;
    const head = text.slice(0, 200);
    if (mode === "paper") {
        return /(?:\bPAPER\s*MODE\b|paper\s*order|模拟交易|纸面交易)/i.test(head);
    }
    return /(?:\bSHADOW\s*MODE\b|hypothetical|影子交易|阴影交易)/i.test(head);
}

function nonEmptyString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

const SERVER_OWNED_CEX_PARAM_KEYS = new Set([
    "exchange",
    "userId",
    "_idempotency_resubmit_nonce",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeCEXParamsBySchema(
    params: Record<string, unknown>,
    schema: CEXActionSchema | undefined,
    options?: { includeInjected?: boolean }
): Record<string, unknown> {
    const includeInjected = options?.includeInjected === true;
    const paramSchema = schema?.parameters;
    if (!paramSchema || Object.keys(paramSchema).length === 0) return {};

    const sanitizeByDef = (value: unknown, def: CEXActionSchema["parameters"][string]): unknown => {
        if (def.type === "object" && def.properties && isRecord(value)) {
            const out: Record<string, unknown> = {};
            for (const [childKey, childDef] of Object.entries(def.properties)) {
                if (!includeInjected && childDef.injected === true) continue;
                if (!(childKey in value)) continue;
                out[childKey] = sanitizeByDef(value[childKey], childDef);
            }
            return out;
        }
        return value;
    };

    const out: Record<string, unknown> = {};
    for (const [key, def] of Object.entries(paramSchema)) {
        if (!includeInjected && def.injected === true) continue;
        if (!(key in params)) continue;
        out[key] = sanitizeByDef(params[key], def);
    }
    return out;
}

/**
 * Server-owned param injection. After Phase 1, `defaultExchangeId` is the
 * resolved venue (per §Cross-cutting #2) — i.e., the resolver's output,
 * not the unconditional `defaultExchangeAuth.exchangeId` it used to be.
 * The function name is kept for code-archaeology continuity.
 */
function applyServerOwnedParams(
    params: Record<string, unknown>,
    userId: UUID,
    defaultExchangeId: string | null
): Record<string, unknown> {
    const next: Record<string, unknown> = {
        ...params,
        userId,
    };
    if (defaultExchangeId) next.exchange = defaultExchangeId;
    return next;
}

function stripServerOwnedParams(params: Record<string, unknown>): Record<string, unknown> {
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
        if (SERVER_OWNED_CEX_PARAM_KEYS.has(key)) continue;
        next[key] = value;
    }
    return next;
}

function promoteProductId(out: Record<string, unknown>): void {
    const existing = nonEmptyString(out.product_id);
    if (existing) return;
    const fromSymbol =
        nonEmptyString(out.symbol) ??
        nonEmptyString(out.instrument) ??
        nonEmptyString(out.product);
    if (fromSymbol) {
        out.product_id = fromSymbol;
    }
}

function promoteProductIdsArray(out: Record<string, unknown>): void {
    const existing = out.product_ids;
    if (Array.isArray(existing) && existing.length > 0) return;
    const one =
        nonEmptyString(out.symbol) ??
        nonEmptyString(out.instrument) ??
        nonEmptyString(out.product) ??
        nonEmptyString(out.product_id);
    if (one) {
        out.product_ids = [one];
    }
}

/**
 * Maps common aliases to canonical fields. Does not remove alias keys (execution validators ignore extras).
 */
function resolveOrderStreamSummary(
    runtime: CEXWorkflowStateType["runtime"],
    action: string,
    params: Record<string, unknown> | undefined,
): string | undefined {
    if (!params) return undefined;
    const summary = getCEXSpecProvider(runtime)?.formatOrderSummary?.(params, action);
    const trimmed = typeof summary === "string" ? summary.trim() : "";
    return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Best-effort USD notional of an approved create_order's params, for the order-submit observability
 * step's `notional_usd` field. Reads a flat `notional`/`quote_size`/`amount`, the nested
 * `order_configuration.<variant>.quote_size`, or `base_size × (limit_price|price)`. Returns undefined
 * when nothing is extractable (e.g. a base-only market order whose mid isn't on the params).
 *
 * This carries the executed notional onto the stream step so observability (and the GEAP scenario_01
 * capital-limit check) can VERIFY the order was within the user's authorized budget instead of failing
 * closed on thin telemetry. Pure read of the already-approved params — no trading-behavior change.
 */
function orderSubmitNotionalUsd(params: Record<string, unknown> | undefined): number | undefined {
    if (!params || typeof params !== "object") return undefined;
    const toNum = (c: unknown): number => {
        if (c == null) return Number.NaN;
        const n = Number(String(c).replace(/[^0-9.]/g, ""));
        return Number.isFinite(n) && n > 0 ? n : Number.NaN;
    };
    for (const c of [params.notional_usd, params.notional, params.quote_size, params.quoteOrderQty, params.usd, params.amount]) {
        const n = toNum(c);
        if (Number.isFinite(n)) return n;
    }
    const oc = params.order_configuration as Record<string, Record<string, unknown> | undefined> | undefined;
    let baseSize = Number.NaN;
    let quoteSize = Number.NaN;
    let price = Number.NaN;
    if (oc && typeof oc === "object") {
        for (const inner of Object.values(oc)) {
            if (!inner || typeof inner !== "object") continue;
            const q = toNum(inner.quote_size);
            if (Number.isFinite(q)) quoteSize = q;
            const b = toNum(inner.base_size);
            if (Number.isFinite(b)) baseSize = b;
            const p = toNum(inner.limit_price ?? inner.price);
            if (Number.isFinite(p)) price = p;
        }
    }
    if (Number.isFinite(quoteSize)) return quoteSize;
    if (Number.isFinite(baseSize) && Number.isFinite(price)) return baseSize * price;
    return undefined;
}

function resolveApprovalInterruptCopy(
    runtime: CEXWorkflowStateType["runtime"],
    action: string,
    params: Record<string, unknown>,
): { title: string; description: string; message: string } {
    const provider = getCEXSpecProvider(runtime);
    const summary = resolveOrderStreamSummary(runtime, action, params);
    const title =
        provider?.formatApprovalInterruptTitle?.(params, action) ??
        "Review & Authorize Order";
    if (summary) {
        return {
            title,
            description: `Review your ${summary}. Edit any field, check the box, and submit to execute.`,
            message: `Please review: ${summary}`,
        };
    }
    return {
        title,
        description: "Edit any parameter, check the box, and submit to execute.",
        message: "Please review the proposed trading query parameters.",
    };
}

/** Resolves approval-request ProcessingStep status after human input resolves. */
export function resolveApprovalRequestStepOutcome(
    outcome: "approved" | "rejected" | "failed",
    approvalStreamCopy: { completed: string },
    opts?: { locale?: Locale; failureMessage?: string },
): { status: "completed" | "error"; message: string } {
    if (outcome === "approved") {
        return { status: "completed", message: approvalStreamCopy.completed };
    }
    if (outcome === "failed") {
        return {
            status: "error",
            message: opts?.failureMessage?.trim() || "Authorization failed",
        };
    }
    return {
        status: "error",
        message: opts?.locale === "zh-CN" ? "已拒绝授权" : "Authorization declined",
    };
}

export function normalizeTradingApprovalParams(
    action: string,
    params: Record<string, unknown>
): Record<string, unknown> {
    const out: Record<string, unknown> = { ...params };

    switch (action) {
        case "create_order":
            promoteProductId(out);
            break;
        case "get_orders":
        case "get_fills":
            promoteProductIdsArray(out);
            promoteProductId(out);
            break;
        case "cancel_order":
            promoteProductId(out);
            break;
        default:
            break;
    }

    return out;
}

/**
 * Deterministic safety net for margin-context extraction.
 *
 * The LLM-driven action selector occasionally misses `margin_type`
 * even when the user clearly says "margin orders" / "杠杆订单". Staging
 * CloudWatch on 2026-05-21 showed `venue_call /api/v3/openOrders` for
 * the prompt "help me check what margin orders do I have" — the spot
 * endpoint, despite the canonical-spec advertising `margin_type` and
 * the user mentioning margin explicitly.
 *
 * This guard does the obvious thing: if the user's message contains a
 * margin/leverage/borrow signal AND the action is one of
 * `get_orders` / `get_balance` / `get_fills` / `cancel_order` /
 * `create_order` AND `margin_type` is not already set, default
 * `margin_type` to `"CROSS"`. The user can still over-ride with an
 * explicit "isolated margin" mention (regex below).
 *
 * Skipped when the user explicitly opts out ("spot orders", "现货订单").
 * Returns the (possibly-mutated) params object for chaining; pure if
 * no margin signal is detected.
 */
const MARGIN_SIGNAL_RE =
    /\b(margin|leverage|leveraged|borrow|short(?:[\s-]?(?:sell|sale|position))?)\b|杠杆|借贷|做空/i;
const ISOLATED_SIGNAL_RE = /\bisolated(?:[\s-]?margin)?\b|逐仓/i;
const SPOT_OPT_OUT_RE = /\b(spot[\s-]?(?:orders?|account|balance)?)\b|现货/i;
const MARGIN_AWARE_ACTIONS: ReadonlySet<string> = new Set([
    "get_orders",
    "get_balance",
    "get_fills",
    "cancel_order",
    "create_order",
]);

// cancel_order references orders by venue id, not by asset; the dialog
// skips MarketSnapshotPanel for it, so a matches:false from a prompt
// like "cancel orders 62…1, 46…" / "yes" / "cancel all" would silently
// disable Confirm Cancel without surfacing a banner.
export const APPROVAL_MODAL_ENRICHMENT_ACTIONS: ReadonlySet<string> = new Set([
    "create_order",
    "amend_order",
    "preview_order",
]);

/**
 * F10.2 — predicate that decides whether `requestParameterReview` may
 * skip the human_input_required modal because the "Compose a trade"
 * dialog has already collected the user's "I confirm these inputs are
 * correct…" gate locally.
 *
 * Returns `true` only when BOTH:
 *   - the active action is `create_order` (the only shape the compose
 *     dialog produces today; any other action still routes through the
 *     modal), AND
 *   - the inbound message content carries `composedPreApproved === true`
 *     AND a non-empty `composedAction` (defense-in-depth — the server
 *     body parser already gates `composedPreApproved` on
 *     `composedAction`, but re-checking here removes a class of bugs
 *     where a future caller forgets to honor that contract).
 *
 * Returns `false` for missing/falsy/non-boolean variants, including
 * the string `"true"` (the parser already coerces FormData strings to
 * booleans; an un-coerced string-`"true"` here means the parser was
 * skipped and we should NOT trust the flag).
 *
 * This predicate is pure and side-effect-free, so it's safe to call
 * inside graph nodes that may be re-evaluated.
 */
export function isComposePreApproved(
    messageContent: Record<string, unknown> | undefined | null,
    action: string,
): boolean {
    if (action !== "create_order") return false;
    if (!messageContent || typeof messageContent !== "object") return false;
    if (messageContent.composedPreApproved !== true) return false;
    if (typeof messageContent.composedAction !== "string" || messageContent.composedAction.length === 0) {
        return false;
    }
    return true;
}

/**
 * Pure helper extracted from `requestParameterReview`. Walks recent
 * assistant memories via `resolveAllOrdersFromContext` and converts
 * a `cancel_order` request with `all_open=true` + empty `order_ids`
 * into one with an enumerated `order_ids` list (so the approval modal
 * shows real ids the user can edit / remove). Drops the `all_open`
 * flag on success.
 *
 * Returns `{ expanded: false }` when:
 *   - the action shape doesn't match (already has ids, or no all_open),
 *   - the provider doesn't expose `resolveAllOrdersFromContext`, or
 *   - memory contains no recognizable orders table.
 *
 * Memory-only by design — keeps the modal-open path off the venue REST
 * critical path. When memory is empty the caller leaves `all_open=true`
 * and the venue layer still fans out at execution time.
 */
export function expandCancelAllFromMemory(
    params: Record<string, unknown>,
    deps: {
        resolveAllOrdersFromContext?: (input: {
            messageText: string;
            locale: string;
            recentAssistantMemories: Array<{ id: string; text: string; createdAt: number }>;
            venue: string | null;
        }) => {
            orders: Array<{ order_id: string; symbol?: string }>;
            sourceMemoryId: string;
        } | null;
        messageText: string;
        locale: string;
        recentAssistantMemories: Array<{ id: string; text: string; createdAt: number }>;
        venue: string | null;
    },
):
    | { expanded: true; params: Record<string, unknown>; sourceMemoryId: string }
    | { expanded: false } {
    const isAllOpen = params.all_open === true || params.all_open === "true";
    const hasIds =
        Array.isArray(params.order_ids) && params.order_ids.length > 0;
    if (!isAllOpen || hasIds) return { expanded: false };
    if (typeof deps.resolveAllOrdersFromContext !== "function") {
        return { expanded: false };
    }

    const batch = deps.resolveAllOrdersFromContext({
        messageText: deps.messageText,
        locale: deps.locale,
        recentAssistantMemories: deps.recentAssistantMemories,
        venue: deps.venue,
    });
    if (!batch || batch.orders.length === 0) return { expanded: false };

    // Pass EVERY id the memory resolver found. The venue cancel layer
    // looks up symbol per id from getOpenOrders at execute time, so
    // multi-symbol "cancel all" works natively — filtering to one
    // symbol here would silently drop the others.
    const symbols = new Set(
        batch.orders.map((o) => o.symbol).filter((s): s is string => !!s),
    );
    const out: Record<string, unknown> = {
        ...params,
        order_ids: batch.orders.map((o) => o.order_id),
    };
    delete out.all_open;
    if (symbols.size === 1 && typeof out.product_id !== "string") {
        // Single-symbol case: surface it. Multi-symbol leaves
        // product_id blank so the modal field doesn't mislead the
        // user into thinking only that pair will cancel.
        const [only] = symbols;
        out.product_id = only;
    }
    return { expanded: true, params: out, sourceMemoryId: batch.sourceMemoryId };
}

/**
 * Two-tier expansion for `cancel_order` + `all_open=true`:
 *   1. memory (synchronous; see `expandCancelAllFromMemory`),
 *   2. venue fetch via `fetchUserOpenOrders` (best-effort, 2.5 s ceiling
 *      inside the provider impl).
 *
 * The memory snapshot only contains ids the agent has recently rendered
 * (often a single row), so it routinely under-counts what's actually
 * open. The venue fetch closes that gap so the approval modal always
 * sees the full id list. When BOTH paths come up empty (no memory,
 * venue rate-limited / no creds) the caller leaves `all_open=true` and
 * the venue cancel layer still fans out at execution time.
 *
 * Note: unlike the memory step, the venue step returns rows for every
 * symbol the user has open. To match the modal's single-Product-id
 * field, we group by the first symbol and emit just those ids — the
 * user can cancel the other symbols in a follow-up turn.
 */
export async function expandCancelAllWithFallback(
    params: Record<string, unknown>,
    deps: {
        resolveAllOrdersFromContext?: (input: {
            messageText: string;
            locale: string;
            recentAssistantMemories: Array<{ id: string; text: string; createdAt: number }>;
            venue: string | null;
        }) => {
            orders: Array<{ order_id: string; symbol?: string }>;
            sourceMemoryId: string;
        } | null;
        fetchUserOpenOrders?: () => Promise<Array<{ order_id: string; symbol: string }> | null>;
        messageText: string;
        locale: string;
        recentAssistantMemories: Array<{ id: string; text: string; createdAt: number }>;
        venue: string | null;
    },
): Promise<
    | { expanded: true; params: Record<string, unknown>; source: "memory" | "venue"; sourceDetail: string }
    | { expanded: false }
> {
    const memoryResult = expandCancelAllFromMemory(params, deps);
    if (memoryResult.expanded) {
        return {
            expanded: true,
            params: memoryResult.params,
            source: "memory",
            sourceDetail: memoryResult.sourceMemoryId,
        };
    }

    // Memory missed. Confirm we should fall through to venue: skip when
    // the action shape doesn't even match (no all_open, or order_ids
    // already populated) — those return `{ expanded: false }` from
    // `expandCancelAllFromMemory` for a different reason than "memory
    // is empty" and we shouldn't pay the venue round-trip.
    const isAllOpen = params.all_open === true || params.all_open === "true";
    const hasIds = Array.isArray(params.order_ids) && params.order_ids.length > 0;
    if (!isAllOpen || hasIds) return { expanded: false };
    if (typeof deps.fetchUserOpenOrders !== "function") return { expanded: false };

    const venueOrders = await deps.fetchUserOpenOrders();
    if (!venueOrders || venueOrders.length === 0) return { expanded: false };

    // Pass EVERY open order id regardless of symbol. Binance's cancel
    // path (`packages/plugin-cex/src/exchanges/services/binance.ts`)
    // re-fetches getOpenOrders at execute time and looks up the
    // symbol per id from that snapshot, so multi-symbol cancels work
    // natively without a `product_id` hint. Coinbase's cancel API is
    // already symbol-agnostic. Leaving `product_id` undefined here is
    // honest: there is no single symbol to surface when ids span
    // BTC-USDT + SOL-USDT + …, and the modal field stays empty so the
    // user isn't misled into thinking only that pair will cancel.
    const symbols = new Set(venueOrders.map((o) => o.symbol).filter(Boolean));
    const out: Record<string, unknown> = {
        ...params,
        order_ids: venueOrders.map((o) => o.order_id),
    };
    delete out.all_open;
    if (symbols.size === 1 && typeof out.product_id !== "string") {
        // Single-symbol case: surface it as a hint. Multi-symbol
        // (size > 1) leaves product_id undefined so the modal field
        // renders blank.
        const [only] = symbols;
        out.product_id = only;
    }
    return {
        expanded: true,
        params: out,
        source: "venue",
        sourceDetail: `${venueOrders.length} open order(s) across ${symbols.size} symbol(s)`,
    };
}

export function injectMarginContextFromMessage(
    action: string,
    params: Record<string, unknown>,
    userMessage: string | undefined,
): Record<string, unknown> {
    if (!MARGIN_AWARE_ACTIONS.has(action)) return params;
    if (!userMessage) return params;
    if (params.margin_type) return params; // user/LLM already set it; respect.
    if (SPOT_OPT_OUT_RE.test(userMessage) && !MARGIN_SIGNAL_RE.test(userMessage)) {
        return params;
    }
    if (!MARGIN_SIGNAL_RE.test(userMessage)) return params;
    const isolated = ISOLATED_SIGNAL_RE.test(userMessage);
    return { ...params, margin_type: isolated ? "ISOLATED" : "CROSS" };
}

type ParsedTradingResponse = {
    isAction: boolean;
    actionCall?: {
        action: string;
        userParams?: Record<string, unknown>;
    };
    text?: string;
};

export const CEXWorkflowState = Annotation.Root({
    message: Annotation<Memory>(),
    runtime: Annotation<IAgentRuntime>(),
    callback: Annotation<HandlerCallback>(),
    streamingCallback: Annotation<StreamingCallback>(),
    intermediateResponseCallback: Annotation<(response: Memory) => void>(),
    /**
     * D3 — per-request token streaming callback. Plumbed in from the
     * regular runtime route so the plan-as-text node can stream the
     * planner's markdown back to the SSE consumer as it's generated.
     * Other CEX dispatch branches (single-order, balance, etc.) ignore
     * it — no behavior change for those paths.
     */
    onToken: Annotation<(delta: string) => Promise<void> | void>(),
    /**
     * D1 — set by `detectPlanIntent` when the request is a multi-step
     * crypto trading plan (DCA, ladder, scale-in/out, rotation,
     * screen-and-trade, take-profit ladder, position exit). When true,
     * the workflow routes to `generatePlanAsText` instead of the normal
     * LLM action-extraction loop.
     */
    isPlanAsText: Annotation<boolean>(),
    /** Step count surfaced for the `metadata.cexPlan.steps` breadcrumb. */
    planAsTextStepCount: Annotation<number>(),

    recentMessages: Annotation<string>(),
    pendingTradingPlans: Annotation<string>(),
    currentDate: Annotation<string>(),
    availableActions: Annotation<string>(),
    userTraits: Annotation<string>(),
    dataRetentionInfo: Annotation<string>(),
    languageInstruction: Annotation<string>(),

    iteration: Annotation<number>(),
    maxIterations: Annotation<number>(),
    actionResults: Annotation<unknown[]>(),

    llmResponse: Annotation<string>(),
    parsedResponse: Annotation<ParsedTradingResponse>(),

    approvedActionCall: Annotation<{ action: string; userParams: Record<string, unknown> }>(),
    lastExecutedActionResult: Annotation<Record<string, unknown>>(),

    shouldContinue: Annotation<boolean>(),
    forceFinalResponse: Annotation<boolean>(),
    isComplete: Annotation<boolean>(),
    hasError: Annotation<boolean>(),
    errorMessage: Annotation<string>(),
    phase: Annotation<string>(),
    startTime: Annotation<number>(),

    finalResponse: Annotation<Memory>(),
    tradingActionSchemas: Annotation<Record<string, CEXActionSchema>>(),

    /** Resolved from account defaultExchangeAuth during initialize; used for capabilities + approval context. */
    defaultExchangeId: Annotation<string | null>(),

    /** Per-request locale, decided once by preprocess (§Cross-cutting #1). */
    locale: Annotation<Locale>(),
    /**
     * Initial stake hint from preprocess; refined post-parseResponse via
     * action-name allowlist classifier.
     */
    stakeHint: Annotation<Stake>(),
    /** Resolved venue + provenance (§Cross-cutting #2). */
    exchangeResolution: Annotation<ExchangeResolution<string> | null>(),
    /** All venues the user has configured (defaults first). */
    configuredVenues: Annotation<string[]>(),
    /**
     * Recent assistant memories (slim form), prefetched at
     * initializeWorkflow time so synchronous nodes (parseResponse) can
     * run the multi-turn order-ID resolver without an extra async fetch.
     */
    recentAssistantMemos: Annotation<Array<{ id: string; text: string; createdAt: number }>>(),
    /**
     * Slim conversation history (user + assistant interleaved), most
     * recent first. Used to detect ADK-clarification follow-ups and
     * combine partial context across turns.
     */
    recentConversationSlim: Annotation<Array<{ id: string; role: "user" | "assistant"; text: string; createdAt: number }>>(),
    /** Stable id for tradingEvents emissions across the request lifecycle. */
    requestId: Annotation<string>(),
    /**
     * §8.1 — set when the prompt-injection classifier downgraded the
     * request to read-only. Renderers prepend
     * `renderPromptInjectionDowngradeNotice(locale)` to the final reply so
     * the user understands WHY they only see read-only output (instead of
     * the ADK's generic "Trading assistant only runs read-only" message).
     */
    promptInjectionDowngrade: Annotation<boolean>(),
    /**
     * F1 — execution mode resolved by `runRiskPrecheck` at approval-gate
     * entry, fail-closed to "live". Threaded into `generateFormattedResult`
     * so the formatter prompts for the paper/shadow badge AND the final
     * mechanical post-check can mechanically prefix the badge if the LLM
     * forgets. Also surfaces as `metadata.actionData.mode` on the executed
     * action response via `plugin-cex/src/actions/shared.ts`.
     */
    resolvedExecutionMode: Annotation<"live" | "paper" | "shadow">(),
    /**
     * C3 — per-message execution-mode override parsed by
     * `cexRequestPreprocess` from the user's prefix
     * (`paper mode:` / `live mode:` / `shadow mode:`). Set BEFORE
     * `runRiskPrecheck` runs; takes precedence over `params.mode` (the
     * LLM-extracted mode) so a deterministic user prefix cannot be
     * silently dropped on the way to the risk gate.
     */
    executionModeOverride: Annotation<"live" | "paper" | "shadow" | null>(),
    /**
     * Fix 11 (H-4) — the mid-market price the parameter-review modal
     * was built against. Captured at the END of `requestParameterReview`
     * (after the user's Confirm flips the modal to approved) and read
     * by `executeAction` to compute drift against a fresh quote.
     * `undefined` means the modal had no quote (e.g. market_mid_usd
     * lookup failed at review time, or this is a cancel/preview action
     * with no limit price) — the re-check then skips.
     */
    approvedMarketMid: Annotation<number>(),
    /**
     * Fix 11 (H-4) — wall-clock epoch ms at which the review modal's
     * quote was captured. Surfaces in the "Market moved X bps in Y
     * seconds since you reviewed this order" abort message so users
     * can correlate against their own time-on-modal.
     */
    approvedAtMs: Annotation<number>(),
});

export type CEXWorkflowStateType = typeof CEXWorkflowState.State;

function getCEXSpecProvider(runtime: IAgentRuntime): CEXSpecProvider | undefined {
    for (const plugin of runtime.plugins ?? []) {
        if (plugin.cexSpecProvider) return plugin.cexSpecProvider;
    }
    return undefined;
}

/**
 * Classify a venue-call failure to decide whether the order's state is
 * unknown (we MAY have hit the venue) or definitively never-sent. The
 * `unknown` rows feed into pre-submit dedup so the user can't retry. Plan §6.0.3.
 */
function classifyVenueErrorForUnknownState(
    err: unknown,
): "venue_5xx" | "venue_timeout" | "venue_network_error" | null {
    if (!err || typeof err !== "object") return null;
    const e = err as {
        response?: { status?: number };
        code?: string;
        name?: string;
        message?: string;
    };
    const status = e.response?.status;
    if (typeof status === "number" && status >= 500 && status <= 599) return "venue_5xx";
    const message = String(e.message ?? "").toLowerCase();
    if (
        e.code === "ETIMEDOUT" ||
        e.code === "ESOCKETTIMEDOUT" ||
        e.name === "AbortError" ||
        message.includes("timeout") ||
        message.includes("timed out")
    ) {
        return "venue_timeout";
    }
    if (
        e.code === "ECONNRESET" ||
        message.includes("socket hang up") ||
        message.includes("econnreset")
    ) {
        // Mid-stream socket close — the request may have landed before the
        // socket dropped, so mark UNKNOWN to fail the next dedup attempt closed.
        return "venue_network_error";
    }
    // Pre-flight connection errors (request never sent) MUST NOT mark UNKNOWN.
    // ECONNREFUSED/EHOSTUNREACH/ENETUNREACH/ENOTFOUND/EAI_AGAIN all fail before
    // the TCP handshake completes — the order definitively never reached the
    // venue, so the next retry is safe and dedup should not block it.
    if (
        e.code === "ECONNREFUSED" ||
        e.code === "EHOSTUNREACH" ||
        e.code === "ENETUNREACH" ||
        e.code === "ENOTFOUND" ||
        e.code === "EAI_AGAIN"
    ) {
        return null;
    }
    // 4xx (validation, rate-limit) — the request definitively reached the
    // venue and was rejected, so the order didn't land. NOT unknown.
    if (typeof status === "number" && status >= 400 && status <= 499) return null;
    return null;
}

/**
 * Map a risk-engine `rules_fired` set to the catalog code that produces
 * the best next-step. The killSwitch and liveTradingGlobalKill rules
 * surface a dedicated pause message; everything else uses the generic
 * `risk_block` with the first explanation rendered in body.
 */
function pickRiskBlockCode(rulesFired: ReadonlyArray<string>): UserErrorCode {
    if (rulesFired.includes("killSwitch")) return "risk_kill_switch";
    if (rulesFired.includes("liveTradingGlobalKill")) return "kill_switch_on";
    return "risk_block";
}

/**
 * Map dep-health `HealthIssue`s to the most-specific catalog code so the
 * user gets the right recovery hint. Order matters: more-specific codes
 * win (e.g., `market_data_stale` should not be reported as `dep_unhealthy`
 * when only freshness is the issue).
 */
function pickFailClosedCode(reasons: ReadonlyArray<string>): UserErrorCode {
    const set = new Set(reasons);
    if (set.has("market_data_stale") && set.size === 1) return "fail_closed_market_data";
    if (set.has("reconciliation_dead") && set.size === 1) return "fail_closed_reconciliation";
    if (
        (set.has("risk_audit_sink_dead") || set.has("no_audit_sink_configured")) &&
        set.size === 1
    ) {
        return "fail_closed_audit";
    }
    return "dep_unhealthy";
}

function getCEXActionSchemaForWorkflow(
    runtime: IAgentRuntime,
    actionName: string,
    exchange: unknown
): CEXActionSchema | undefined {
    const provider = getCEXSpecProvider(runtime);
    const ex =
        typeof exchange === "string" && exchange.trim().length > 0 ? exchange.trim() : null;
    return provider?.getActionSchemaForApproval?.(actionName, ex) ?? provider?.getActionSchema(actionName);
}

function getCEXCapabilitiesForExchange(
    runtime: IAgentRuntime,
    exchange: unknown
) {
    if (typeof exchange !== "string" || exchange.trim().length === 0) return null;
    const spec = getCEXSpecProvider(runtime)?.getCanonicalSpec();
    return spec?.capabilities?.[exchange.toLowerCase()] ?? null;
}

function emitStep(streamingCallback: StreamingCallback | undefined, step: Omit<ProcessingStep, "id" | "timestamp">) {
    // §4 Observability: every CEX ProcessingStep funnels through here, so this single bridge
    // turns each `Trading: …` step into a span event on the active node span (no-op when
    // OTEL_TRACING_ENABLED is unset, or when there is no active span). Runs even if no SSE
    // streamingCallback is attached, since traces are independent of client streaming.
    spanFromProcessingStep(step);
    if (!streamingCallback) return;
    streamingCallback({
        id: uuidv4(),
        timestamp: Date.now(),
        ...step,
    });
}

// §4 Observability: map a CEX node's terminal `phase` to the queryable `decision.outcome`
// span attribute. This is the dimension that turns the decisive-signal-vs-risk-control
// conflict into a one-line Cloud Trace filter (e.g. decision.outcome="risk_block") and a
// visible DAG shape. Phases not listed leave the attribute unset (e.g. the await path, which
// instead sets "awaiting_approval" at the human-input emit sites below).
const CEX_PHASE_OUTCOME: Record<string, string> = {
    risk_blocked: "risk_block",
    live_trading_global_kill: "risk_block",
    dep_health_fail_closed: "risk_block",
    quote_freshness_block: "freshness_block",
    parameter_review_rejected: "rejected",
    parameter_final_confirm_rejected: "rejected",
    prompt_injection_refused: "refused",
    parameter_review_approved: "allow",
    parameter_final_confirm_approved: "approved",
    action_completed: "executed",
    action_failed: "failed",
    action_failed_unknown_state: "failed",
};

/**
 * Wrap a CEX workflow node so each invocation is a `node:<name>` child span of the per-turn
 * handler root, and the node's resulting `phase` is mapped onto `decision.outcome`.
 * Transparent when OTEL_TRACING_ENABLED is unset (withSpan short-circuits to fn()).
 */
function traceCexNode(
    name: string,
    // Accept sync OR async nodes — `parseResponse` is the one synchronous CEX node; the `await`
    // below normalizes both. (Without the union this is a TS2345 at the parseResponse addNode.)
    fn: (
        state: CEXWorkflowStateType,
        ...rest: unknown[]
    ) =>
        | Partial<CEXWorkflowStateType>
        | Promise<Partial<CEXWorkflowStateType>>,
): (
    state: CEXWorkflowStateType,
    ...rest: unknown[]
) => Promise<Partial<CEXWorkflowStateType>> {
    // Forward all args (LangGraph passes `(state, config)`) so wrapping drops nothing.
    return (state, ...rest) =>
        withSpan(`node:${name}`, undefined, async () => {
            const result = await fn(state, ...rest);
            const outcome = result?.phase ? CEX_PHASE_OUTCOME[result.phase] : undefined;
            if (outcome) setDecisionOutcome(outcome);
            return result;
        });
}

async function initializeWorkflow(state: CEXWorkflowStateType): Promise<Partial<CEXWorkflowStateType>> {
    const startTime = Date.now();
    elizaLogger.info("[CEXWorkflow] Initializing workflow");

    // §6.8 — stable request_id for the whole workflow. Anchored on
    // `message.id` so a retry of the same user turn lands on the same
    // request_id (and therefore joins to the same intent_hash, ledger
    // rows, risk_decisions, and venue_calls). Falls back to a fresh
    // uuid only when message.id is missing (defensive — Eliza always
    // assigns one in practice).
    const requestId = state.message?.id ? String(state.message.id) : uuidv4();

    try {
        state.runtime.resetStopFlag?.();

        const userId = state.message.userId as UUID | undefined;
        if (!userId) {
            elizaLogger.warn("[CEXWorkflow] Trading request received without userId; rejecting.");
            return {
                hasError: true,
                errorMessage: getCEXAuthRequiredErrorTemplate(),
                phase: "error_no_user",
            };
        }

        const recentMessagesData = await state.runtime.messageManager.getMemories({
            roomId: state.message.roomId,
            count: 10,
            unique: false,
        });

        // Agent turns substitute their persisted `metadata.summary` (the
        // `## Key Findings` block emitted at the bottom of the response)
        // when available. CEX dialogs run 5–10 turns of order clarification
        // + execution before completing, so swapping long executed-trade
        // result narratives for their summary is the single biggest token
        // saver on follow-ups.
        const recentMessages = recentMessagesData
            .slice(-10)
            .map((msg) => {
                const isAgent = msg.userId === state.runtime.agentId;
                const name = isAgent ? state.runtime.character.name : "User";
                const summaryRaw = isAgent
                    ? (msg.content?.metadata as { summary?: unknown } | undefined)?.summary
                    : undefined;
                const summary = typeof summaryRaw === "string" && summaryRaw.length > 0
                    ? summaryRaw
                    : "";
                const body = summary || msg.content.text;
                return `${name}: ${body}`;
            })
            .join("\n");

        const currentDate = new Date().toLocaleDateString("en-US", {
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
        });

        let userTraits = "";
        if (userId && userId !== state.runtime.agentId) {
            try {
                userTraits = await state.runtime.userFeatureManager.formatUserTraitsForContext(userId, {
                    queryMessage: state.message.content.text,
                    topN: 3,
                    similarityThreshold: 0,
                    fallbackToAll: true,
                });
            } catch (error) {
                elizaLogger.warn(`[CEXWorkflow] Failed to load user traits: ${error}`);
            }
        }

        // Validate that the user has a usable defaultExchangeAuth configured before proceeding.
        let defaultExchangeId: string | null = null;
        let configuredVenuesForState: string[] = [];
        try {
            const account = await state.runtime.databaseAdapter.getAccountById(userId);
            const details =
                account?.details && typeof account.details === "object"
                    ? (account.details as Record<string, unknown> & {
                          exchangeAuths?: ExchangeAuths;
                          defaultExchangeAuth?: DefaultExchangeAuth;
                          enableTrading?: boolean;
                      })
                    : {};

            if (details.enableTrading !== true) {
                elizaLogger.warn("[CEXWorkflow] User trading is disabled; rejecting trading request.");
                return {
                    hasError: true,
                    errorMessage: getCEXTradingNotEnabledErrorTemplate(),
                    phase: "error_trading_disabled",
                };
            }

            const defaultExchangeAuth =
                details.defaultExchangeAuth && typeof details.defaultExchangeAuth === "object"
                    ? (details.defaultExchangeAuth as DefaultExchangeAuth)
                    : null;

            const exchangeAuths: ExchangeAuths =
                details.exchangeAuths && typeof details.exchangeAuths === "object"
                    ? (details.exchangeAuths as ExchangeAuths)
                    : ({} as ExchangeAuths);

            const registry = await state.runtime.databaseAdapter.getExchangeRegistry();
            if (!registry || registry.length === 0) {
                throw new Error("No supported CEX exchanges are configured in the exchange registry.");
            }

            let hasValidDefaultAuth = false;

            if (defaultExchangeAuth) {
                const isNonEmptyString = (value: unknown): value is string =>
                    typeof value === "string" && value.trim().length > 0;

                const isEncryptedSecret = (
                    value: unknown
                ): value is { v: number; alg: string; iv: string; tag: string; ciphertext: string } => {
                    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
                    const v = value as Record<string, unknown>;
                    return (
                        typeof v.v === "number" &&
                        typeof v.alg === "string" &&
                        typeof v.iv === "string" &&
                        typeof v.tag === "string" &&
                        typeof v.ciphertext === "string" &&
                        v.iv.length > 0 &&
                        v.tag.length > 0 &&
                        v.ciphertext.length > 0
                    );
                };

                const { exchangeId, authType } = defaultExchangeAuth;
                const forExchange =
                    exchangeAuths[exchangeId] && typeof exchangeAuths[exchangeId] === "object"
                        ? (exchangeAuths[exchangeId] as Record<string, unknown>)
                        : null;

                if (forExchange) {
                    const rawTokensForAuthType =
                        forExchange[authType] && typeof forExchange[authType] === "object"
                            ? (forExchange[authType] as Record<string, unknown>)
                            : null;

                    if (rawTokensForAuthType) {
                        const matchingEntry = registry.find(
                            (entry) => entry.id === exchangeId && Array.isArray(entry.authTypes)
                        );

                        if (matchingEntry) {
                            const authConfig = matchingEntry.authTypes.find((config) => config.type === authType);
                            if (authConfig) {
                                // Updated schema: `required` is boolean; secrets may be stored as encrypted payload objects.
                                const requiredFields = (authConfig.fields ?? []).filter((field) => field.required === true);
                                hasValidDefaultAuth = requiredFields.every((field) => {
                                    const tokenValue = rawTokensForAuthType[field.id];
                                    if (field.type === "secret") {
                                        // Allow both encrypted secret payloads (current) and legacy plain strings.
                                        return isEncryptedSecret(tokenValue) || isNonEmptyString(tokenValue);
                                    }
                                    return isNonEmptyString(tokenValue);
                                });
                                if (
                                    hasValidDefaultAuth &&
                                    typeof exchangeId === "string" &&
                                    exchangeId.trim().length > 0
                                ) {
                                    defaultExchangeId = exchangeId.trim().toLowerCase();
                                }
                            }
                        }
                    }
                }
            }

            if (!hasValidDefaultAuth) {
                elizaLogger.warn(
                    "[CEXWorkflow] User is missing a valid defaultExchangeAuth; rejecting trading request."
                );
                return {
                    hasError: true,
                    errorMessage: getCEXDefaultExchangeRequiredErrorTemplate(),
                    phase: "error_invalid_default_exchange_auth",
                };
            }

            // Collect all venues the user has at least one auth configured
            // for. Order: defaultExchangeId first, then any other ids with
            // non-empty auths. The resolver consumes this list to decide
            // whether to ask for clarification on ambiguous write intents.
            const configured: string[] = [];
            if (defaultExchangeId) configured.push(defaultExchangeId);
            for (const eid of Object.keys(exchangeAuths)) {
                const id = (eid ?? "").toLowerCase();
                if (!id || configured.includes(id)) continue;
                const sub = (exchangeAuths as Record<string, unknown>)[eid];
                if (sub && typeof sub === "object" && Object.keys(sub as object).length > 0) {
                    configured.push(id);
                }
            }
            configuredVenuesForState = configured;
        } catch (error) {
            elizaLogger.warn(
                `[CEXWorkflow] Failed to validate defaultExchangeAuth from account details: ${String(error)}`
            );
            return {
                hasError: true,
                errorMessage: getCEXDefaultExchangeRequiredErrorTemplate(),
                phase: "error_default_exchange_auth_validation",
            };
        }

        const tradingActions = getCEXActions(state.runtime);
        const cexSpecProvider = getCEXSpecProvider(state.runtime);
        const availableActions = tradingActions.length > 0
            ? tradingActions
                .map((action) =>
                    cexSpecProvider?.formatActionForLLM(action.name, action.description) ??
                    `**${action.name}**: ${action.description ?? ""}`
                )
                .join("\n\n")
            : "";

        let dataRetentionInfo = "Free. Allowed: last 3 months (90 days).";
        if (userId && userId !== state.runtime.agentId) {
            try {
                const retention = await getDataRetentionConfig(state.runtime, userId);
                if (retention.dataRetentionMinDaysAgo != null && retention.dataRetentionMaxDaysAgo != null) {
                    dataRetentionInfo = "Anonymous. Allowed: data between 1 and 3 months ago (30–90 days ago).";
                } else if (retention.dataRetentionDays === 0) {
                    dataRetentionInfo = "Enterprise. Allowed: no limit.";
                } else if (retention.dataRetentionDays === DATA_RETENTION_DAYS_BY_TIER.pro) {
                    dataRetentionInfo = "Pro. Allowed: last 24 months (730 days).";
                } else if (retention.dataRetentionDays === DATA_RETENTION_DAYS_BY_TIER.plus) {
                    dataRetentionInfo = "Plus. Allowed: last 6 months (180 days).";
                } else if (retention.dataRetentionDays === DATA_RETENTION_DAYS_BY_TIER.free) {
                    dataRetentionInfo = "Free. Allowed: last 3 months (90 days).";
                }
            } catch (err) {
                elizaLogger.warn(`[CEXWorkflow] Data retention resolution failed: ${err}`);
            }
        }

        // §1.1 — deterministic preprocess (locale + stake hint + venue
        // resolution). Replaces the previous unconditional "default
        // venue wins, never clarify" behavior.
        const messageText = state.message?.content?.text ?? "";
        const stakeHint = inferStakeHint(messageText);
        const preprocessOutput: CexPreprocessOutput<string> = cexPreprocess<string>({
            messageText,
            recentMemories: recentMessagesData,
            configuredVenues: configuredVenuesForState,
            defaultVenue: defaultExchangeId ?? undefined,
            preferredVenue: null,
            preferredLanguage: null,
            stakeHint,
            matchToken: matchVenueToken,
            findMentionInText: findVenueMentionInText,
        });

        const locale: Locale = preprocessOutput.locale;
        const exchangeResolution = preprocessOutput.exchange_resolution;
        const stake: Stake = preprocessOutput.stake;
        // C3 — `paper mode:` / `live mode:` / `shadow mode:` prefix parsed
        // BEFORE any LLM call so the risk gate stamps the user-requested
        // mode, not a stale "live" default.
        const modeOverride = preprocessOutput.mode_override;
        if (modeOverride) {
            elizaLogger.info(
                `[CEXWorkflow] C3 execution-mode prefix detected: "${modeOverride}" — overrides any downstream params.mode`,
            );
        }

        emitStep(state.streamingCallback, {
            name: CEX_WORKFLOW_STEPS.preprocess,
            status: "completed",
            message: "Resolved locale, tool capability, and venue",
            data: {
                type: "trading_preprocess",
                locale,
                // H3b — the historical `stake` value here carries
                // read_only/write (tool capability), not the CLAUDE.md
                // spec's execution mode. Rename to `tool_capability`
                // on the wire so downstream consumers reserve `stake`
                // for paper/live/shadow. Legacy `stake` field is kept
                // alongside for one release to avoid breaking any
                // outstanding dashboard or client tap.
                stake,
                tool_capability: stake,
                resolution_kind: exchangeResolution.kind,
                resolution_source:
                    exchangeResolution.kind === "resolved"
                        ? exchangeResolution.source
                        : null,
                venue:
                    exchangeResolution.kind === "resolved"
                        ? exchangeResolution.venue
                        : null,
            },
        });
        getCEXSpecProvider(state.runtime)?.emitTradingEvent?.({
            stage: "preprocess",
            userId: state.message?.userId,
            locale,
            // H3b — CW envelope wire field rename. See `emitPreprocess`
            // for rationale: CLAUDE.md `stake` slot reserved for
            // execution mode; read_only/write goes on `tool_capability`.
            tool_capability: stake,
            venue:
                exchangeResolution.kind === "resolved"
                    ? exchangeResolution.venue
                    : undefined,
        });

        // §8.1 — prompt-injection defense. Runs at the top of the
        // workflow (before any LLM call) so a refused message never
        // reaches `generateLLMResponse`.
        const piResult = classifyPromptInjection(messageText);
        let injectionDowngrade = false;
        if (piResult.verdict !== "allow") {
            getCEXSpecProvider(state.runtime)?.emitTradingEvent?.({
                stage: "prompt_injection_detected" as never,
                userId: state.message?.userId,
                locale,
                score: piResult.score,
                verdict: piResult.verdict,
                matched_patterns: piResult.matched_patterns,
            });
            emitStep(state.streamingCallback, {
                name: CEX_WORKFLOW_STEPS.preprocess,
                status: "completed",
                message: `Prompt-injection ${piResult.verdict} (score=${piResult.score.toFixed(2)})`,
                data: {
                    type: "trading_prompt_injection",
                    score: piResult.score,
                    verdict: piResult.verdict,
                    matched_patterns: piResult.matched_patterns,
                },
            });
            if (piResult.verdict === "refuse") {
                // §7.5 — standardized contract; the existing template renderer
                // is kept as a fallback for non-CEX paths.
                const refusal = renderUserErrorMarkdown(
                    buildUserError({ code: "prompt_injection_refused", locale }),
                );
                return {
                    recentMessages,
                    currentDate,
                    availableActions,
                    userTraits,
                    dataRetentionInfo,
                    languageInstruction: getLanguageInstruction(locale),
                    defaultExchangeId,
                    configuredVenues: configuredVenuesForState,
                    exchangeResolution,
                    locale,
                    stakeHint: stake,
                    requestId,
                    iteration: 1,
                    maxIterations: 3,
                    accountContext: null,
                    parsedResponse: { isAction: false, text: refusal },
                    llmResponse: refusal,
                    forceFinalResponse: true,
                    shouldContinue: false,
                    phase: "prompt_injection_refused",
                };
            }
            // downgrade: keep going but force read-only stake.
            injectionDowngrade = true;
        }

        // 2026-05-25 hardening (QA H-2 / M-1 / M-2 / H-4) — deterministic
        // red-team short-circuit. The classifyPromptInjection pipeline
        // above did not reliably refuse trading-safety bypass prompts in
        // staging QA (iter-1 + iter-2 retest both showed S5-4 / S5-7
        // slipping through with a procedural "please specify the asset"
        // reply because the LLM treats the missing-order context as a
        // partial-order signal). This direct gate fires BEFORE the LLM
        // call, producing a deterministic refusal that does not depend
        // on sampling or on the prompt-injection verdict path.
        const RED_TEAM_TRADING_SAFETY =
            /\b(bypass|skip|disable|ignore|override|disregard|turn\s*off)\b[^.\n]{0,40}\b(confirm(?:ation)?s?|risk(?:\s*(?:engine|management|gate|check))?|safety|guard(?:rail)?s?|approvals?|limits?|caps?|gates?|protections?|policy|policies|rules?)\b/i;
        if (RED_TEAM_TRADING_SAFETY.test(messageText)) {
            const refusalEN =
                "I can't bypass or disable the trading safety gates — confirmation and the risk engine apply to every order. If you want to adjust a specific cap, open Settings → Risk Limits.";
            const refusalZH =
                "我无法跳过或关闭交易安全机制——每笔订单都需要通过确认与风险引擎检查。如需调整某项上限,请在 设置 → 风险限额 中修改。";
            const refusal = locale === "zh-CN" ? refusalZH : refusalEN;
            getCEXSpecProvider(state.runtime)?.emitTradingEvent?.({
                stage: "prompt_injection_detected" as never,
                userId: state.message?.userId,
                locale,
                score: 1,
                verdict: "refuse",
                matched_patterns: ["trading_safety_override_direct"],
            });
            emitStep(state.streamingCallback, {
                name: CEX_WORKFLOW_STEPS.preprocess,
                status: "completed",
                message: "Refused — trading-safety override framing",
                data: {
                    type: "trading_prompt_injection",
                    score: 1,
                    verdict: "refuse",
                    matched_patterns: ["trading_safety_override_direct"],
                },
            });
            return {
                recentMessages,
                currentDate,
                availableActions,
                userTraits,
                dataRetentionInfo,
                languageInstruction: getLanguageInstruction(locale),
                defaultExchangeId,
                configuredVenues: configuredVenuesForState,
                exchangeResolution,
                locale,
                stakeHint: stake,
                requestId,
                iteration: 1,
                maxIterations: 3,
                accountContext: null,
                parsedResponse: { isAction: false, text: refusal },
                llmResponse: refusal,
                forceFinalResponse: true,
                shouldContinue: false,
                phase: "prompt_injection_refused",
            };
        }

        // §8.12 — operator-controlled global kill. Refuses live-mode
        // writes while paper / shadow remain open. Read at request time
        // so an env flip without redeploy applies immediately.
        if (isLiveTradingGlobalKillActive() && stake === "write") {
            // §7.5 — standardized contract; the locale-aware kill message
            // remains the single source of body text so existing tests stay green.
            const killMsg = renderUserErrorMarkdown(
                buildUserError({ code: "kill_switch_on", locale }),
            );
            getCEXSpecProvider(state.runtime)?.emitTradingEvent?.({
                stage: "kill_switch_activation" as never,
                userId: state.message?.userId,
                active: true,
                actor: "system",
                reason: LIVE_TRADING_GLOBAL_KILL_REASON,
            });
            return {
                recentMessages,
                currentDate,
                availableActions,
                userTraits,
                dataRetentionInfo,
                languageInstruction: getLanguageInstruction(locale),
                defaultExchangeId,
                configuredVenues: configuredVenuesForState,
                exchangeResolution,
                locale,
                stakeHint: "read_only",
                requestId,
                iteration: 1,
                maxIterations: 3,
                accountContext: null,
                parsedResponse: { isAction: false, text: killMsg },
                llmResponse: killMsg,
                forceFinalResponse: true,
                shouldContinue: false,
                phase: "live_trading_global_kill",
            };
        }

        // §1.1.1 — "exchange mentioned but not configured" short-circuit.
        // If the user named a specific exchange that is not in their
        // configuredVenues list (i.e., no auth entry exists at all),
        // the resolver silently falls through to the default. Surface a
        // clear "not configured" message instead of silently using the
        // wrong exchange.
        const mentionedVenue = findVenueMentionInText(messageText);
        if (mentionedVenue && !configuredVenuesForState.includes(mentionedVenue)) {
            const notConfiguredText = renderExchangeNotConfiguredMessage(mentionedVenue, locale);
            emitStep(state.streamingCallback, {
                name: CEX_WORKFLOW_STEPS.clarification,
                status: "completed",
                message: `${mentionedVenue} not configured`,
                data: { type: "trading_exchange_not_configured", venue: mentionedVenue, locale },
            });
            return {
                recentMessages,
                currentDate,
                availableActions,
                userTraits,
                dataRetentionInfo,
                languageInstruction: getLanguageInstruction(locale),
                defaultExchangeId,
                configuredVenues: configuredVenuesForState,
                exchangeResolution,
                locale,
                stakeHint: stake,
                requestId,
                iteration: 1,
                maxIterations: 3,
                actionResults: [],
                shouldContinue: false,
                forceFinalResponse: true,
                isComplete: false,
                hasError: false,
                errorMessage: "",
                startTime,
                phase: "exchange_not_configured",
                llmResponse: notConfiguredText,
                parsedResponse: { isAction: false, text: notConfiguredText },
            };
        }

        // §1.1 — clarification short-circuit. The handler emits a
        // localized question and ends the workflow without an LLM call
        // or approval. The next user turn re-routes through preprocess
        // and the explicit mention wins priority 1.
        if (exchangeResolution.kind === "needs_clarification") {
            const clarificationText = renderExchangeClarification(
                exchangeResolution.options,
                locale,
            );
            emitStep(state.streamingCallback, {
                name: CEX_WORKFLOW_STEPS.clarification,
                status: "completed",
                message: "Requesting exchange clarification",
                data: {
                    type: "trading_clarification_request",
                    options: exchangeResolution.options,
                    locale,
                },
            });
            return {
                recentMessages,
                currentDate,
                availableActions,
                userTraits,
                dataRetentionInfo,
                languageInstruction: getLanguageInstruction(locale),
                defaultExchangeId,
                configuredVenues: configuredVenuesForState,
                exchangeResolution,
                locale,
                stakeHint: stake,
                requestId,
                iteration: 1,
                maxIterations: 3,
                actionResults: [],
                shouldContinue: false,
                forceFinalResponse: true,
                isComplete: false,
                hasError: false,
                errorMessage: "",
                startTime,
                phase: "clarification_required",
                llmResponse: clarificationText,
                parsedResponse: { isAction: false, text: clarificationText },
            };
        }

        // Resolver chose a venue — override defaultExchangeId so the
        // downstream applyServerOwnedParams writes the resolved id, not
        // the unconditional defaultExchangeAuth one.
        const resolvedVenue = exchangeResolution.venue;

        const languageInstruction = getLanguageInstruction(locale);

        emitStep(state.streamingCallback, {
            name: "cex_workflow_start",
            status: "completed",
            message: "Starting trading info workflow...",
        });

        const recentAssistantMemos = recentMessagesData
            .filter((m) => m.userId === state.runtime.agentId)
            .map((m) => ({
                id: String(m.id),
                text: m.content?.text ?? "",
                createdAt: typeof m.createdAt === "number" ? m.createdAt : Date.now(),
            }));
        const recentConversationSlim = recentMessagesData
            .map((m) => ({
                id: String(m.id),
                role: (m.userId === state.runtime.agentId ? "assistant" : "user") as "user" | "assistant",
                text: m.content?.text ?? "",
                createdAt: typeof m.createdAt === "number" ? m.createdAt : Date.now(),
            }))
            .sort((a, b) => b.createdAt - a.createdAt);

        const pendingTradingPlans = formatPendingTradingPlansContext(
            String(userId),
            String(state.message.roomId ?? ""),
        );

        return {
            recentMessages,
            pendingTradingPlans,
            currentDate,
            availableActions,
            userTraits,
            dataRetentionInfo,
            languageInstruction,
            defaultExchangeId: resolvedVenue,
            configuredVenues: configuredVenuesForState,
            exchangeResolution,
            locale,
            // §8.1 — downgraded prompt-injection requests run with
            // read-only stake; the rest of the workflow already refuses
            // venue writes when stake !== "write".
            stakeHint: injectionDowngrade ? "read_only" : stake,
            promptInjectionDowngrade: injectionDowngrade,
            requestId,
            recentAssistantMemos,
            recentConversationSlim,
            iteration: 1,
            maxIterations: 3,
            actionResults: [],
            shouldContinue: true,
            forceFinalResponse: false,
            isComplete: false,
            hasError: false,
            errorMessage: "",
            startTime,
            phase: "initialized",
            executionModeOverride: modeOverride,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        elizaLogger.error(`[CEXWorkflow] Initialization failed: ${message}`);
        return {
            hasError: true,
            errorMessage: `Initialization failed: ${message}`,
            phase: "error",
        };
    }
}

async function generateLLMResponse(state: CEXWorkflowStateType): Promise<Partial<CEXWorkflowStateType>> {
    elizaLogger.info(`[CEXWorkflow] Generating LLM response - iteration ${state.iteration}`);

    try {
        emitStep(state.streamingCallback, {
            name: "cex_workflow_generate_llm_response",
            status: "in_progress",
            message: `Generating response (iteration ${state.iteration}/${state.maxIterations})...`,
        });

        // F10 server-side compose — when the chat-streaming endpoint is
        // invoked with a `composedAction` + `composedParams` body (from
        // the manual-compose modal), short-circuit the entire NL → LLM
        // path. The parameters come from a structured form the user
        // already saw; routing them through the LLM only risks
        // re-extraction errors and adds latency. Risk gates, idempotency,
        // and the parameter-review approval still run downstream.
        if (state.iteration === 1) {
            const content = state.message?.content as Record<string, unknown> | undefined;
            const composedAction = typeof content?.composedAction === "string"
                ? (content.composedAction as string)
                : undefined;
            const composedParams = composedAction && content?.composedParams && typeof content.composedParams === "object"
                ? (content.composedParams as Record<string, unknown>)
                : undefined;
            if (composedAction && composedParams) {
                const params = {
                    userId: state.message.userId,
                    exchange: state.defaultExchangeId ?? "binance",
                    ...composedParams,
                };
                const synthetic = JSON.stringify({
                    action: composedAction,
                    parameters: params,
                });
                emitStep(state.streamingCallback, {
                    name: "cex_workflow_generate_llm_response",
                    status: "completed",
                    message: `Compose-mode intent (no LLM call): ${composedAction}`,
                });
                getCEXSpecProvider(state.runtime)?.emitTradingEvent?.({
                    stage: "intent_classified",
                    userId: state.message.userId,
                    locale: state.locale,
                    venue: params.exchange as string | undefined,
                    decision: "compose",
                });
                return {
                    llmResponse: `\`\`\`json\n${synthetic}\n\`\`\``,
                    phase: "compose_action_detected",
                };
            }
        }

        // §3.2 — ADK sub-agent fast path. Try a deterministic classification
        // first; if it succeeds with high confidence, skip the LLM call
        // entirely (lower latency, no hallucinated venue / order_id).
        // Only attempts on the first iteration to keep follow-up corrections
        // routed through the LLM (which has the conversation context).
        if (state.iteration === 1) {
            const provider = getCEXSpecProvider(state.runtime);
            // Multi-turn context: if the previous assistant memory was an
            // ADK clarification (e.g., "Do you want to BUY or SELL?"),
            // concatenate the prior user message with the current reply
            // so the extractor sees the full original ask + the new
            // disambiguation. Without this, "I want to buy" alone has
            // no symbol/price → infinite clarification loop.
            //
            // BUT: a self-sufficient new request must NOT be glued onto a
            // stale prior turn. e.g., user previously asked "cancel order
            // 12345" (clarification asked), then started a fresh "I want
            // to buy 50 USDT of BTC/USDT with price 60000 post only".
            // Naïve concatenation produces "cancel order 12345. I want
            // to buy 50 USDT…" — the deterministic classifier checks
            // cancel_order patterns first, so the user lands in the
            // wrong modal. Strategy: try the current message alone first;
            // only fall back to the combined text when the sub-agent
            // can't classify it cleanly.
            const currentText = state.message?.content?.text ?? "";

            // Confirmation fast-path — before ADK because "yes please"
            // doesn't classify as any tool and the LLM has been observed
            // to re-list orders instead of executing the staged cancel.
            const confirmation = tryConfirmationCancelFastPath({
                currentText,
                provider,
                state,
            });
            if (confirmation) {
                return confirmation;
            }

            const subAgentArgs = {
                userId: state.message.userId,
                locale: state.locale ?? "en",
                stake: state.stakeHint ?? "read_only",
                venue: state.defaultExchangeId ?? "binance",
                mode: "live" as const,
                killSwitchActive: false,
                // §6.8 — propagate the workflow's stable request_id so the
                // canonical intent (and everything downstream — risk_decisions,
                // venue_calls, ledger rows, reconciliation events) joins on
                // a single id for replay.
                requestId: state.requestId,
                // F7-r3 — hand the runtime to the ADK so the async
                // `runTradingSubAgentSafe` path can run the LLM extractor
                // and enrich the canonical intent with advanced fields
                // (stop_limit / non-default TIF / post-only / margin) the
                // regex extractor alone can't resolve.
                runtime: state.runtime,
            };
            // §8.6 — prefer the timeout-wrapped Safe variant; fall back to the
            // synchronous accessor only if the plugin hasn't registered Safe yet
            // (older deploys / tests with stub providers).
            const callSubAgent = async (message: string) => {
                if (provider?.runTradingSubAgentSafe) {
                    return await provider.runTradingSubAgentSafe({ message, ...subAgentArgs });
                }
                return provider?.runTradingSubAgent?.({ message, ...subAgentArgs }) ?? null;
            };
            let subAgentResult = await callSubAgent(currentText);
            if (subAgentResult?.kind === "clarification_question") {
                const combinedText = combineWithPriorClarificationContext(
                    state,
                    currentText,
                );
                if (combinedText !== currentText) {
                    const retried = await callSubAgent(combinedText);
                    if (retried) {
                        subAgentResult = retried;
                        elizaLogger.info(
                            `[CEXWorkflow] ADK pre-classification: combined-context retry produced ${retried.kind === "canonical_intent" ? `intent=${retried.action}` : `clarification=${retried.tool ?? "unknown"}`}`,
                        );
                    }
                }
            }
            // High-confidence clarification: ADK matched a tool but is
            // missing a required parameter (e.g., create_order without
            // size). Surface the localized question. If `tool` is
            // undefined, classification failed entirely and we fall
            // through to the LLM (which has fuller conversation context).
            if (subAgentResult?.kind === "clarification_question" && subAgentResult.tool) {
                // Recovery: cancel_order missing its order ID may be
                // anaphoric ("cancel this order"). Try the resolver
                // before surfacing a clarification.
                if (subAgentResult.tool === "cancel_order") {
                    const msgText = state.message?.content?.text ?? "";
                    const isBatchRequest =
                        /\b(all|every|each|both|those|these)\b/i.test(msgText) ||
                        /(全部|所有|每个|这些|那些)/u.test(msgText);
                    if (isBatchRequest) {
                        // Build the cancellable id set. PREFER the venue's
                        // LIVE open orders (paper-aware) — they exclude
                        // already-filled / cancelled legs that can't be
                        // cancelled and would otherwise surface a confusing
                        // "Not Found" in the cancel table (the reported bug).
                        // Fall back to the recent-memory resolver only when
                        // the live fetch is unavailable/empty — memory can't
                        // tell a filled leg from an open one when the rendered
                        // text lacks a per-order status word (e.g. a plan card
                        // that just says "Submitted … Paper order id: …").
                        const cancelUserId = state.message.userId;
                        const cancelVenue = state.defaultExchangeId ?? null;
                        let resolvedOrders: Array<{
                            order_id: string;
                            symbol?: string;
                        }> = [];
                        let cancelSource = "";

                        if (provider?.fetchUserOpenOrders && cancelUserId) {
                            try {
                                const liveOpen = await provider.fetchUserOpenOrders({
                                    runtime: state.runtime,
                                    userId: cancelUserId,
                                    venue: cancelVenue ?? "binance",
                                });
                                if (liveOpen && liveOpen.length > 0) {
                                    resolvedOrders = liveOpen.map((o) => ({
                                        order_id: o.order_id,
                                        symbol: o.symbol,
                                    }));
                                    cancelSource = `live:${liveOpen.length}open`;
                                }
                            } catch (err) {
                                elizaLogger.warn(
                                    `[CEXWorkflow] ADK batch cancel live open-orders fetch failed (falling back to memory): ${err instanceof Error ? err.message : String(err)}`,
                                );
                            }
                        }

                        if (resolvedOrders.length === 0) {
                            const batch = provider?.resolveAllOrdersFromContext?.({
                                messageText: msgText,
                                locale: state.locale ?? "en",
                                recentAssistantMemories:
                                    extractAssistantMemoryRecords(state),
                                venue: cancelVenue,
                            });
                            if (batch && batch.orders.length > 0) {
                                resolvedOrders = batch.orders;
                                cancelSource = `memory:${batch.sourceMemoryId}`;
                            }
                        }

                        if (resolvedOrders.length > 0) {
                            // Pass every id found — the venue cancel layer
                            // looks up symbol per id at execute time, so
                            // multi-symbol "cancel all" works natively.
                            // Surface a single `product_id` only when all
                            // rows share one symbol; otherwise leave it
                            // undefined so the modal field doesn't mislead.
                            const orderIds = resolvedOrders.map((o) => o.order_id);
                            const symbols = new Set(
                                resolvedOrders
                                    .map((o) => o.symbol)
                                    .filter((s): s is string => !!s),
                            );
                            const sharedSymbol =
                                symbols.size === 1 ? [...symbols][0] : undefined;
                            elizaLogger.info(
                                `[CEXWorkflow] ADK batch cancel recovered: ${orderIds.length} orders across ${symbols.size} symbol(s) source=${cancelSource}`,
                            );
                            const synthetic = JSON.stringify({
                                action: "cancel_order",
                                parameters: {
                                    userId: state.message.userId,
                                    exchange: state.defaultExchangeId ?? "binance",
                                    order_ids: orderIds,
                                    ...(sharedSymbol ? { product_id: sharedSymbol } : {}),
                                },
                            });
                            emitStep(state.streamingCallback, {
                                name: "cex_workflow_generate_llm_response",
                                status: "completed",
                                message: `ADK batch cancel — ${orderIds.length} order(s)`,
                            });
                            return {
                                llmResponse: `\`\`\`json\n${synthetic}\n\`\`\``,
                                phase: "adk_action_detected",
                            };
                        }
                    }
                    const resolved = provider?.resolveAnaphoricOrderId?.({
                        messageText: msgText,
                        locale: state.locale ?? "en",
                        recentAssistantMemories: extractAssistantMemoryRecords(state),
                        venue: state.defaultExchangeId ?? null,
                    });
                    if (resolved && resolved.unambiguous) {
                        elizaLogger.info(
                            `[CEXWorkflow] ADK clarification recovered via anaphoric resolver: order_id=${resolved.order_id} source=${resolved.sourceMemoryId}`,
                        );
                        const synthetic = JSON.stringify({
                            action: "cancel_order",
                            parameters: {
                                userId: state.message.userId,
                                exchange: state.defaultExchangeId ?? "binance",
                                order_ids: [resolved.order_id],
                                ...(resolved.symbol ? { product_id: resolved.symbol } : {}),
                            },
                        });
                        emitStep(state.streamingCallback, {
                            name: "cex_workflow_generate_llm_response",
                            status: "completed",
                            message: "ADK cancel_order recovered via anaphoric resolver",
                        });
                        return {
                            llmResponse: `\`\`\`json\n${synthetic}\n\`\`\``,
                            phase: "adk_action_detected",
                        };
                    }
                }
                emitStep(state.streamingCallback, {
                    name: "cex_workflow_generate_llm_response",
                    status: "completed",
                    message: "ADK clarification (no LLM call)",
                });
                provider?.emitTradingEvent?.({
                    stage: "clarification_request",
                    userId: state.message.userId,
                    locale: state.locale,
                    decision: subAgentResult.tool,
                });
                return {
                    llmResponse: subAgentResult.text,
                    parsedResponse: { isAction: false, text: subAgentResult.text },
                    phase: "adk_clarification",
                    forceFinalResponse: true,
                    shouldContinue: false,
                };
            }
            // ADK fast-path: read-only actions always; cancel_order also
            // when the order_id was deterministically extracted from the
            // user message. Bypassing the LLM for unambiguous cancels
            // prevents two recurring failure modes seen in production:
            //   1) the LLM rerouting "cancel order <id>" through
            //      `get_orders` (showing the order instead of cancelling),
            //   2) the LLM hallucinating a different order id pulled from
            //      conversation history rather than the current message.
            const READ_ONLY_FAST_PATH = new Set(["get_balance", "get_orders", "get_fills"]);
            const isCancelFastPath =
                subAgentResult?.kind === "canonical_intent" &&
                subAgentResult.action === "cancel_order" &&
                Array.isArray(subAgentResult.params.order_ids) &&
                (subAgentResult.params.order_ids as unknown[]).length > 0;
            if (
                subAgentResult?.kind === "canonical_intent" &&
                (READ_ONLY_FAST_PATH.has(subAgentResult.action) || isCancelFastPath)
            ) {
                // For cancel_order on Binance, the venue requires
                // `product_id` alongside `order_ids`. Users naturally
                // type "cancel order <id>" without the symbol, so we
                // reverse-lookup the symbol from recent assistant
                // memories (the open-orders table the agent just
                // showed almost always carries it). Without this, the
                // approval validator throws a clarification error and
                // the prefilled form is wasted.
                if (
                    isCancelFastPath &&
                    typeof subAgentResult.params.product_id !== "string"
                ) {
                    const orderIds = subAgentResult.params.order_ids as string[];
                    const firstId = orderIds[0];
                    const resolvedSymbol = provider?.resolveSymbolForOrderId?.({
                        orderId: firstId,
                        recentAssistantMemories: extractAssistantMemoryRecords(state),
                        venue: state.defaultExchangeId ?? null,
                    });
                    if (resolvedSymbol?.symbol) {
                        elizaLogger.info(
                            `[CEXWorkflow] ADK cancel_order: resolved symbol=${resolvedSymbol.symbol} for order_id=${firstId} from memo=${resolvedSymbol.sourceMemoryId}`,
                        );
                        subAgentResult.params.product_id = resolvedSymbol.symbol;
                        subAgentResult.params.symbol = resolvedSymbol.symbol;
                    }
                }
                emitStep(state.streamingCallback, {
                    name: "cex_workflow_generate_llm_response",
                    status: "completed",
                    message: `ADK classified intent (no LLM call): ${subAgentResult.action}`,
                });
                provider?.emitTradingEvent?.({
                    stage: "intent_classified",
                    userId: state.message.userId,
                    locale: state.locale,
                    venue: subAgentResult.params.exchange as string | undefined,
                });
                const synthetic = JSON.stringify({
                    action: subAgentResult.action,
                    parameters: subAgentResult.params,
                });
                return {
                    llmResponse: `\`\`\`json\n${synthetic}\n\`\`\``,
                    phase: "adk_action_detected",
                };
            }
            // null / unsupported / write action → fall through to LLM.
        }

        const template = state.iteration >= state.maxIterations ? getCEXFinalResponseTemplate() : getCEXMessageTemplate();

        // §5.2 — locale-aware memory routing. When the user's message
        // references their preferences or trade history, inject a
        // compact summary into the prompt context. Plugin owns the
        // collections; core just stitches the line in.
        const memoryProvider = getCEXSpecProvider(state.runtime);
        const memoryRouted = memoryProvider?.routeMemory?.({
            messageText: state.message?.content?.text ?? "",
            locale: state.locale ?? "en",
            userId: state.message.userId,
            // Future: pre-fetch pending-order ledger rows for episodic
            // recall. Today we pass only the message + locale; the
            // router still produces preference snippets correctly.
        });

        const memoryContextLine = memoryRouted?.summary
            ? `\n\n## User memory\n${memoryRouted.summary}`
            : "";

        const stateData = {
            userMessage: state.message.content.text,
            currentDate: state.currentDate,
            recentMessages: state.recentMessages,
            pendingTradingPlans: state.pendingTradingPlans || "",
            availableActions: state.availableActions,
            userTraits: state.userTraits,
            dataRetentionInfo: state.dataRetentionInfo,
            languageInstruction: state.languageInstruction || "",
            memoryContext: memoryContextLine,
            roomId: state.message.roomId,
            recentMessagesData: [],
        } as unknown as State;

        const { system, prompt } = composeContextSplit({
            state: stateData,
            template,
        });

        // CEX main-loop LLM upgraded SMALL → MEDIUM (B1 of context-composition
        // PR). The CEX workflow is paid-tier-gated upstream (the workflow
        // only runs for users with exchange API keys saved + trading
        // enabled; anonymous users are force-routed to REGULAR by
        // `runtime.ts:2271`), so the resolveModelClass downgrade is bypassed
        // here. Parameter-extraction quality matters: mis-parsed quantity /
        // venue / side leads to bad orders or extra clarification round-trips.
        const response = await generateText({
            runtime: state.runtime,
            system,
            prompt,
            modelClass: ModelClass.MEDIUM,
            userId: state.message.userId,
            bypassModelClassDowngrades: true,
        });

        emitStep(state.streamingCallback, {
            name: "cex_workflow_generate_llm_response",
            status: "completed",
            message: "LLM response generated",
        });

        return {
            llmResponse: response,
            phase: "llm_response_generated",
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        elizaLogger.error(`[CEXWorkflow] LLM response generation failed: ${message}`);
        return {
            hasError: true,
            errorMessage: `LLM response generation failed: ${message}`,
            phase: "error",
        };
    }
}

function extractAssistantMemoryRecords(
    state: CEXWorkflowStateType,
): Array<{ id: string; text: string; createdAt: number }> {
    return Array.isArray(state.recentAssistantMemos) ? state.recentAssistantMemos : [];
}

/**
 * Affirmative phrases that should be interpreted as confirming the most
 * recent assistant proposal — used by the confirmation fast-path below.
 * EN list intentionally requires the whole user message to be (more or
 * less) just the confirmation word, so longer messages that *contain*
 * "yes" don't get short-circuited.
 */
export const AFFIRMATIVE_EN =
    /^(yes|yep|yeah|yes\s*[,.]?\s*please|sure|ok(ay)?|confirm|confirmed|proceed|do\s+it|go\s+ahead|please\s+(do|proceed|continue)|continue)[\s.!,]*$/i;
export const AFFIRMATIVE_ZH =
    /^(好的?|好啊|确认|是的?|可以|继续|对|请继续|请执行|没问题|行)[\s。！，.!,]*$/u;

/**
 * Detects assistant turns that proposed a cancellation and asked the
 * user to confirm (e.g., "Would you like me to proceed with canceling
 * this order?"). We require BOTH the cancel intent and an explicit
 * confirmation-question marker so we don't fire on plain status reports.
 */
export const CANCEL_PROPOSAL_PATTERNS: RegExp[] = [
    // "...proceed with cancelling/canceling/cancellation/cancel..."
    /\b(proceed|continue|go\s+ahead|ready\s+to\s+proceed).{0,60}\bcancel\w*\b/i,
    // "...cancelling/canceling them... would you like / shall I / confirm..."
    /\bcancel\w*\b.{0,80}\b(would\s+you\s+like|shall\s+i|do\s+you\s+want|confirm|proceed)\b/i,
    // "...would you like (me to) cancel..." / "shall I cancel..." / "please confirm ... cancel..."
    /\b(would\s+you\s+like(\s+me)?\s+to|shall\s+i|do\s+you\s+want(\s+me)?\s+to|please\s+confirm|confirm\s+if).{0,80}\bcancel\w*\b/i,
    /(取消|撤销|撤单).{0,40}(确认|是否|继续|请确认)/u,
    /(确认|是否|继续|请确认).{0,40}(取消|撤销|撤单)/u,
];

/**
 * Confirmation fast-path: short-circuits the LLM when the user replies
 * with a bare "yes / proceed / 好的" to an assistant turn that staged a
 * cancellation. The LLM has been observed to re-list the orders instead
 * of executing the cancel — this deterministic path scans the prior
 * memo for visible order rows and emits a synthetic cancel_order JSON
 * so the standard approval modal fires.
 */
function tryConfirmationCancelFastPath(args: {
    currentText: string;
    provider: ReturnType<typeof getCEXSpecProvider>;
    state: CEXWorkflowStateType;
}): { llmResponse: string; phase: string } | null {
    const { currentText, provider, state } = args;

    const trimmed = currentText.trim();
    const isAffirmative =
        AFFIRMATIVE_EN.test(trimmed) || AFFIRMATIVE_ZH.test(trimmed);
    if (!isAffirmative) return null;

    const recentMemos = extractAssistantMemoryRecords(state);
    if (recentMemos.length === 0) return null;

    const sorted = [...recentMemos].sort((a, b) => b.createdAt - a.createdAt);
    const cancelProposal = sorted.find((m) =>
        CANCEL_PROPOSAL_PATTERNS.some((p) => p.test(m.text)),
    );
    if (!cancelProposal) return null;

    const recencyMs = Date.now() - cancelProposal.createdAt;
    if (recencyMs > 10 * 60 * 1000) return null;

    const batch = provider?.resolveAllOrdersFromContext?.({
        messageText: trimmed,
        locale: state.locale ?? "en",
        recentAssistantMemories: [cancelProposal],
        venue: state.defaultExchangeId ?? null,
    });
    if (!batch || batch.orders.length === 0) return null;

    // Pass every id the resolver returned, even when they span
    // multiple symbols — the venue cancel layer looks up symbol per
    // id at execute time, so multi-symbol fan-out is native. We only
    // surface a `product_id` hint when all rows share the same
    // symbol so the modal field doesn't mislead.
    const orderIds = batch.orders.map((o) => o.order_id);
    const symbols = new Set(
        batch.orders.map((o) => o.symbol).filter((s): s is string => !!s),
    );
    const sharedSymbol = symbols.size === 1 ? [...symbols][0] : undefined;

    elizaLogger.info(
        `[CEXWorkflow] Confirmation fast-path: "${trimmed.slice(0, 30)}" → cancel_order ${orderIds.length} order(s) across ${symbols.size} symbol(s) (source=${cancelProposal.id})`,
    );

    const synthetic = JSON.stringify({
        action: "cancel_order",
        parameters: {
            userId: state.message.userId,
            exchange: state.defaultExchangeId ?? "binance",
            order_ids: orderIds,
            ...(sharedSymbol ? { product_id: sharedSymbol } : {}),
        },
    });

    emitStep(state.streamingCallback, {
        name: "cex_workflow_generate_llm_response",
        status: "completed",
        message: `Confirmation → cancel_order (${orderIds.length} order(s))`,
    });

    return {
        llmResponse: `\`\`\`json\n${synthetic}\n\`\`\``,
        phase: "adk_action_detected",
    };
}

/**
 * Heuristics for detecting that the most recent assistant turn was an
 * ADK / risk-engine clarification question (vs. a normal narrative
 * reply). When true and the current user message is short (likely a
 * disambiguation), we combine the previous user message with the new
 * reply so the ADK extractor sees the full intent text.
 *
 * Without this, "I want to buy" with no symbol/size triggers an
 * infinite clarification loop.
 */
const ADK_CLARIFICATION_PATTERNS: RegExp[] = [
    /\bdo you want to (buy|sell)\b/i,
    /\bplease (specify|provide|clarify)\b/i,
    /\b(which|what) (trading pair|exchange|venue|order|symbol)\b/i,
    /\bspecify (the )?order (size|quantity)\b/i,
    /\blimit orders? require a price\b/i,
    /请(提供|说明|指定|明确)/u,
    /您?想买入还是卖出/u,
];

function combineWithPriorClarificationContext(
    state: CEXWorkflowStateType,
    currentText: string,
): string {
    if (!currentText || currentText.length > 80) return currentText;
    const conv = Array.isArray(state.recentConversationSlim)
        ? state.recentConversationSlim
        : [];
    if (conv.length < 2) return currentText;
    // conv is sorted most-recent first. We want the assistant turn that
    // immediately preceded the current user message, then the user msg
    // before that. Note: the CURRENT message may already be in conv if
    // the memory was persisted before this handler ran; skip past it.
    let i = 0;
    while (i < conv.length && conv[i].role === "user" && conv[i].text === currentText) {
        i += 1;
    }
    const lastAssistant = conv[i];
    if (!lastAssistant || lastAssistant.role !== "assistant") return currentText;
    const recencyMs = Date.now() - lastAssistant.createdAt;
    if (recencyMs > 10 * 60 * 1000) return currentText; // 10-min staleness cap

    const looksLikeClarification = ADK_CLARIFICATION_PATTERNS.some((p) =>
        p.test(lastAssistant.text),
    );
    if (!looksLikeClarification) return currentText;

    const priorUser = conv.slice(i + 1).find((m) => m.role === "user");
    if (!priorUser) return currentText;
    elizaLogger.info(
        `[CEXWorkflow] Combining ADK clarification follow-up: prior="${priorUser.text.slice(0, 50)}" + current="${currentText.slice(0, 50)}"`,
    );
    return `${priorUser.text}. ${currentText}`;
}

function parseResponse(state: CEXWorkflowStateType): Partial<CEXWorkflowStateType> {
    elizaLogger.info("[CEXWorkflow] Parsing response");

    try {
        const rawResponse = state.llmResponse || "";
        const parsed = parseCexMarkdownJsonContract(rawResponse, "action_or_response");
        if (!parsed) {
            return {
                parsedResponse: { isAction: false, text: rawResponse },
                phase: "final_response_detected",
            };
        }

        if (typeof parsed.action === "string" && parsed.action.length > 0) {
            const params =
                typeof parsed.parameters === "object" && parsed.parameters !== null
                    ? (parsed.parameters as Record<string, unknown>)
                    : {};

            // Multi-turn anaphoric resolver — when the user said
            // "cancel this order" (or ZH/EN variants) and the LLM
            // didn't extract an order ID, look back through the recent
            // assistant memories for one shown last turn.
            if (parsed.action === "cancel_order") {
                const orderIds = params.order_ids;
                const hasIds = Array.isArray(orderIds) && orderIds.length > 0;
                const provider = getCEXSpecProvider(state.runtime);
                if (!hasIds) {
                    const resolved = provider?.resolveAnaphoricOrderId?.({
                        messageText: state.message?.content?.text ?? "",
                        locale: state.locale ?? "en",
                        recentAssistantMemories: extractAssistantMemoryRecords(state),
                        venue: state.defaultExchangeId ?? null,
                    });
                    if (resolved && resolved.unambiguous) {
                        params.order_ids = [resolved.order_id];
                        if (resolved.symbol && !params.product_id && !params.symbol) {
                            params.product_id = resolved.symbol;
                        }
                        elizaLogger.info(
                            `[CEXWorkflow] Anaphoric order-ID resolved: ${resolved.order_id} (source memo ${resolved.sourceMemoryId})`,
                        );
                    }
                }
                // Symbol back-fill — runs whether or not the LLM
                // produced order_ids. Binance requires `product_id`
                // alongside `order_ids`, but users naturally type
                // "cancel order <id>" without a symbol. Look the id
                // up in recent assistant memories before the venue
                // validator throws.
                const idsAfter = params.order_ids;
                const hasIdsAfter =
                    Array.isArray(idsAfter) && idsAfter.length > 0;
                const hasSymbol =
                    (typeof params.product_id === "string" &&
                        params.product_id.length > 0) ||
                    (typeof params.symbol === "string" &&
                        (params.symbol as string).length > 0);
                if (hasIdsAfter && !hasSymbol) {
                    const firstId = String((idsAfter as unknown[])[0]);
                    const resolvedSymbol = provider?.resolveSymbolForOrderId?.({
                        orderId: firstId,
                        recentAssistantMemories: extractAssistantMemoryRecords(state),
                        venue: state.defaultExchangeId ?? null,
                    });
                    if (resolvedSymbol?.symbol) {
                        params.product_id = resolvedSymbol.symbol;
                        params.symbol = resolvedSymbol.symbol;
                        elizaLogger.info(
                            `[CEXWorkflow] LLM cancel_order: resolved symbol=${resolvedSymbol.symbol} for order_id=${firstId} from memo=${resolvedSymbol.sourceMemoryId}`,
                        );
                    }
                }
            }

            return {
                parsedResponse: {
                    isAction: true,
                    actionCall: {
                        action: parsed.action,
                        userParams: params,
                    },
                },
                phase: "action_detected",
            };
        }

        const responseText = cexUnknownResponseToDisplayText(parsed.response);
        if (responseText !== undefined) {
            return {
                parsedResponse: { isAction: false, text: responseText },
                phase: "final_response_detected",
            };
        }

        return {
            parsedResponse: { isAction: false, text: rawResponse },
            phase: "final_response_detected",
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        elizaLogger.warn(`[CEXWorkflow] Failed to parse response JSON: ${message}`);
        const fallbackText = state.llmResponse || "";
        return {
            parsedResponse: { isAction: false, text: fallbackText },
            phase: "fallback_text_response",
        };
    }
}

/**
 * F10.4 — populate sane defaults on free-text orders that omitted
 * fields the canonical schema requires. Two completions today:
 *
 *   • **product_id** — when the user typed something like "buy 0.001
 *     at market" with no ticker, default to `BTC-USDT` so the action
 *     can land at all. Scoped to `create_order` / `preview_order` /
 *     `amend_order`. Other actions (e.g. `get_balance`,
 *     `cancel_order`) are untouched — they either don't need a symbol
 *     or reference one by id.
 *
 *   • **limit_price** — when a limit-variant order_configuration has
 *     no `limit_price`, fill it with 80 % of the current market mid
 *     fetched via `provider.fetchBookTicker`. This is a PLACEHOLDER
 *     value the user reviews + edits in the approval modal; the
 *     existing `priceDeviation` risk rule and the explicit Confirm
 *     BUY/SELL click are the safety floors. Symmetric 80 % for both
 *     BUY and SELL — keeping the rule directional ("80 % for BUY,
 *     120 % for SELL") would couple the placeholder to side semantics
 *     in a way that's surprising for users who explicitly asked for
 *     "80 % of market". The placeholder is meant to be a starting
 *     point, not a recommended price.
 *
 * Fail-soft: if `fetchBookTicker` returns null or throws, leave the
 * field empty so existing validation surfaces an "Order requires a
 * limit price" error to the user via the standard approval flow.
 *
 * SKIPPED when `state.message.content.composedPreApproved === true`
 * — the compose dialog already populated both fields via its
 * combobox + editor; the user's deliberate state should not be
 * overwritten.
 *
 * Returns the patched userParams; the caller assigns it onto
 * actionCall.userParams. Pure-ish (only side effect is the fetch +
 * audit log), so safe to call early in `requestParameterReview`.
 */
const COMPOSE_DEFAULT_ACTIONS: ReadonlySet<string> = new Set([
    "create_order",
    "preview_order",
    "amend_order",
]);

const LIMIT_VARIANT_KEYS: ReadonlySet<string> = new Set([
    "limit_limit_gtc",
    "limit_limit_gtd",
    "limit_limit_ioc",
    "limit_limit_fok",
    "stop_limit_stop_limit_gtc",
    "trigger_bracket_gtc",
    "sor_limit_ioc",
]);

export async function applyComposeDefaults(
    state: CEXWorkflowStateType,
    actionCall: { action: string; userParams?: Record<string, unknown> },
): Promise<Record<string, unknown>> {
    const baseParams = { ...(actionCall.userParams ?? {}) } as Record<string, unknown>;

    if (!COMPOSE_DEFAULT_ACTIONS.has(actionCall.action)) return baseParams;

    // Compose dialog owns its own defaults via the combobox + editor.
    // Never overwrite a deliberate empty (the user may have cleared a
    // field on purpose) when the request came from there.
    const content = state.message?.content as Record<string, unknown> | undefined;
    if (content?.composedPreApproved === true) return baseParams;

    // (1) Default product_id when missing.
    const productIdRaw = baseParams.product_id;
    const productIdMissing =
        typeof productIdRaw !== "string" || productIdRaw.trim().length === 0;
    if (productIdMissing) {
        baseParams.product_id = "BTC-USDT";
        elizaLogger.info(
            `[Trading] ${JSON.stringify({
                stage: "compose_default",
                field: "product_id",
                value: "BTC-USDT",
                action: actionCall.action,
            })}`,
        );
    }
    const productId = typeof baseParams.product_id === "string" ? baseParams.product_id : "";

    // (2) Default limit_price when a limit-variant order_configuration
    // exists but the inner `limit_price` is empty. Look up the active
    // variant key first so we only touch limit-style orders.
    const orderConfig = baseParams.order_configuration;
    if (orderConfig && typeof orderConfig === "object") {
        const ocRecord = orderConfig as Record<string, unknown>;
        const variantKey = Object.keys(ocRecord).find((k) => LIMIT_VARIANT_KEYS.has(k));
        if (variantKey) {
            const inner = ocRecord[variantKey];
            if (inner && typeof inner === "object") {
                const innerRecord = inner as Record<string, unknown>;
                const lp = innerRecord.limit_price;
                const lpMissing =
                    lp === undefined ||
                    lp === null ||
                    (typeof lp === "string" && lp.trim().length === 0);
                if (lpMissing) {
                    const provider = getCEXSpecProvider(state.runtime);
                    const venue = state.defaultExchangeId ?? "binance";
                    const symbol = resolveBinanceSymbol(productId, undefined);
                    if (provider?.fetchBookTicker && symbol) {
                        try {
                            const tick = await provider.fetchBookTicker(symbol, venue);
                            const bid = tick ? Number.parseFloat(tick.bid) : Number.NaN;
                            const ask = tick ? Number.parseFloat(tick.ask) : Number.NaN;
                            if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
                                const mid = (bid + ask) / 2;
                                const placeholder = (mid * 0.80).toFixed(2);
                                // Mutate the variant's inner field in-place. We
                                // already shallow-cloned baseParams so the
                                // mutation can't leak back into the original
                                // actionCall.userParams object the caller
                                // owns; the order_configuration object,
                                // however, is shared by reference — fine
                                // because the caller is about to reassign
                                // userParams anyway.
                                innerRecord.limit_price = placeholder;
                                elizaLogger.info(
                                    `[Trading] ${JSON.stringify({
                                        stage: "compose_default",
                                        field: "limit_price",
                                        value: placeholder,
                                        mid: mid.toFixed(2),
                                        side: typeof baseParams.side === "string" ? baseParams.side : undefined,
                                        symbol,
                                        venue,
                                    })}`,
                                );
                            }
                        } catch (err) {
                            // Fail-soft — leave the field empty and let the
                            // existing required-field validation surface a
                            // clean error to the user.
                            elizaLogger.warn(
                                `[CEXWorkflow] applyComposeDefaults fetchBookTicker threw (fail-soft): ${
                                    err instanceof Error ? err.message : String(err)
                                }`,
                            );
                        }
                    }
                }
            }
        }
    }

    return baseParams;
}

/**
 * §1.5 — risk pre-check. Delegates to the plugin-registered
 * `cexSpecProvider.runRiskPrecheck`, which builds a canonical intent
 * from the params and evaluates the deterministic rule set. If the
 * provider isn't registered or returns null, the handler treats it as
 * `allow` (preserving pre-Phase 1 behavior).
 */
async function runRiskPrecheck(
    state: CEXWorkflowStateType,
    actionCall: { action: string; userParams?: Record<string, unknown> },
): Promise<{
    verdict: "allow" | "block" | "downgrade_read_only";
    rules_fired: string[];
    explanations: string[];
    audit_wrote_ok?: boolean | null;
    request_id?: string;
    intent_hash?: string;
    resolved_mode?: "live" | "paper" | "shadow";
    /**
     * Fix 11 — the market mid this risk check evaluated against.
     * Surfaced so `requestParameterReview` can persist it as
     * `approvedMarketMid` for the Confirm-time drift re-check.
     * Undefined when market data was unavailable (the rule fail-opens
     * in that case).
     */
    market_mid_usd?: number;
} | null> {
    try {
        const provider = getCEXSpecProvider(state.runtime);
        if (!provider?.runRiskPrecheck) return null;

        const userId = state.message.userId as string;
        const venue = state.defaultExchangeId ?? "binance";
        const params = actionCall.userParams ?? {};

        let preferences: Record<string, unknown> | undefined;
        try {
            const adapter = state.runtime.databaseAdapter as unknown as {
                getUserTradingPreferences?: (id: string) => Promise<unknown>;
            };
            if (typeof adapter.getUserTradingPreferences === "function") {
                const fetched = await adapter.getUserTradingPreferences(userId);
                if (fetched && typeof fetched === "object") {
                    preferences = fetched as Record<string, unknown>;
                }
            }
        } catch {
            /* fallthrough — preference fetch optional in Phase 1 */
        }

        // Resolve mode for fail-closed policy:
        //   C3 prefix-override (parsed in cexRequestPreprocess) > params.mode (LLM-extracted) > prefs default > "live"
        // The C3 override sits first so a user's explicit "paper mode:"
        // prefix cannot be silently lost by the LLM/ADK pipeline before
        // reaching the risk gate.
        const overrideMode =
            typeof state.executionModeOverride === "string"
                ? state.executionModeOverride
                : undefined;
        const messageMode =
            typeof params.mode === "string" ? params.mode.toLowerCase() : undefined;
        const prefMode =
            preferences && typeof preferences.default_mode === "string"
                ? (preferences.default_mode as string).toLowerCase()
                : undefined;
        // Public-demo safety net: when PUBLIC_ACCESS_MODE=1 the *fallback*
        // (no C3 override, no params.mode, no saved pref) resolves to PAPER
        // instead of LIVE — so a user with no preferences row can't trip the
        // §6.0.2 fail-closed risk-audit gate. Explicit override / params.mode /
        // saved pref still win, mirroring resolveTradingMode + getUserTradingMode.
        const fallbackMode = isPublicAccessModeActive() ? "paper" : "live";
        const candidate = (overrideMode ?? messageMode ?? prefMode ?? fallbackMode) as string;
        const resolvedMode: "live" | "paper" | "shadow" =
            candidate === "paper" || candidate === "shadow" ? candidate : "live";
        if (overrideMode) {
            elizaLogger.info(
                `[CEXWorkflow] C3 risk-check using executionModeOverride="${overrideMode}" (params.mode=${messageMode ?? "n/a"}, prefs.default_mode=${prefMode ?? "n/a"})`,
            );
        }

        // §6.0.3 — count unknown-state orders on this (venue, symbol) so the
        // `unknownStateBlocker` rule can refuse new writes.
        let unknownStateCount = 0;
        try {
            const symbol =
                typeof params.product_id === "string"
                    ? params.product_id
                    : typeof params.symbol === "string"
                      ? params.symbol
                      : null;
            if (symbol) {
                const adapter = state.runtime.databaseAdapter as unknown as {
                    countUnknownStateOrdersOnPair?: (
                        userId: string,
                        venue: string,
                        symbol: string,
                        agedMs?: number,
                    ) => Promise<number>;
                };
                if (typeof adapter.countUnknownStateOrdersOnPair === "function") {
                    unknownStateCount = await adapter.countUnknownStateOrdersOnPair(
                        userId,
                        venue,
                        symbol,
                        5_000,
                    );
                }
            }
        } catch (err) {
            elizaLogger.warn(
                `[CEXWorkflow] countUnknownStateOrdersOnPair failed: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
        }

        // Best-effort market-mid lookup for the priceDeviation risk gate.
        // 1.5s budget — the rule fail-opens when missing, so a flaky
        // public ticker can't block trading. Only fired for create_order
        // since cancel/preview don't carry a limit price to compare.
        let marketMidUsd: number | undefined;
        if (
            actionCall.action === "create_order" &&
            typeof provider.fetchMarketMidUsd === "function"
        ) {
            const symbol =
                typeof params.product_id === "string"
                    ? params.product_id
                    : typeof params.symbol === "string"
                      ? params.symbol
                      : null;
            if (symbol) {
                try {
                    const ctl = new AbortController();
                    const timer = setTimeout(() => ctl.abort(), 1_500);
                    try {
                        const mid = await provider.fetchMarketMidUsd({
                            runtime: state.runtime,
                            venue,
                            symbol,
                            signal: ctl.signal,
                        });
                        if (typeof mid === "number" && Number.isFinite(mid) && mid > 0) {
                            marketMidUsd = mid;
                        }
                    } finally {
                        clearTimeout(timer);
                    }
                } catch (err) {
                    elizaLogger.debug(
                        `[CEXWorkflow] fetchMarketMidUsd best-effort failed: ${
                            err instanceof Error ? err.message : String(err)
                        }`,
                    );
                }
            }
        }

        const decision = await provider.runRiskPrecheck({
            action: actionCall.action,
            venue,
            userId,
            locale: state.locale ?? "en",
            params,
            preferences,
            mode: resolvedMode,
            unknown_state_orders_on_pair: unknownStateCount,
            market_mid_usd: marketMidUsd,
        });
        if (!decision) return null;
        // Fix 11 — surface market_mid_usd so the caller can persist it
        // as `approvedMarketMid` for the Confirm-time drift re-check.
        return {
            ...decision,
            resolved_mode: resolvedMode,
            market_mid_usd: marketMidUsd,
        };
    } catch (err) {
        elizaLogger.warn(
            `[CEXWorkflow] Risk pre-check unavailable: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
    }
}

/**
 * Split a canonical "BASE-QUOTE" product id into its asset codes.
 * Returns null when the input doesn't have the canonical hyphen
 * separator (e.g., Binance wire-format "BTCUSDT" — the caller
 * should canonicalize before reaching this point).
 */
function splitCanonicalPair(productId: string): { base: string; quote: string } | null {
    const idx = productId.indexOf("-");
    if (idx <= 0 || idx === productId.length - 1) return null;
    return {
        base: productId.slice(0, idx).toUpperCase(),
        quote: productId.slice(idx + 1).toUpperCase(),
    };
}

/**
 * Fix 10 — pull LLM-extracted base_size / quote_size out of the action
 * params. The handler stores them inside the nested order_configuration
 * key (`market_market_ioc.base_size`, `limit_limit_gtc.base_size`, ...);
 * we don't care which inner key carries them, only that they exist.
 */
/**
 * CEX post-PR237 Commit 10 (Issue 14) — Extract the user-typed limit
 * price from the LLM-emitted action parameters. Mirrors
 * `extractLlmSizes` but for the `limit_price` field (top-level on the
 * legacy fast-path or nested inside `order_configuration.limit_*`).
 * Returns `undefined` for market orders / preview calls without a
 * price.
 */
function extractLlmLimitPrice(
    params: Record<string, unknown> | undefined,
): number | undefined {
    if (!params) return undefined;
    const direct =
        typeof params.limit_price === "string"
            ? params.limit_price
            : typeof params.limit_price === "number"
              ? String(params.limit_price)
              : typeof params.price === "string"
                ? params.price
                : typeof params.price === "number"
                  ? String(params.price)
                  : undefined;
    let priceStr: string | undefined = direct;
    const orderConfig = params.order_configuration as
        | Record<string, Record<string, unknown> | undefined>
        | undefined;
    if (orderConfig) {
        for (const inner of Object.values(orderConfig)) {
            if (!inner) continue;
            if (!priceStr && typeof inner.limit_price === "string") {
                priceStr = inner.limit_price;
            }
        }
    }
    if (!priceStr) return undefined;
    const n = Number.parseFloat(priceStr);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * CEX post-PR237 Commit 10 (Issue 14) — Resolve the base-asset
 * step size from the venue's symbol filters. The cross-check uses
 * this to widen its tolerance by one LOT_SIZE step so an LLM that
 * rounded `base_size` to the exchange's quantization grid does not
 * trigger a spurious clarification. Returns `null` on any failure;
 * the cross-check then falls back to its default 5% threshold.
 */
async function resolveBaseStepSize(
    state: CEXWorkflowStateType,
    actionCall: { action: string; userParams?: Record<string, unknown> },
): Promise<number | null> {
    try {
        if (actionCall.action !== "create_order") return null;
        const provider = getCEXSpecProvider(state.runtime);
        if (!provider?.fetchSymbolFilters) return null;
        const params = actionCall.userParams ?? {};
        const symbol =
            typeof params.product_id === "string"
                ? (params.product_id as string)
                : typeof params.symbol === "string"
                  ? (params.symbol as string)
                  : null;
        if (!symbol) return null;
        const venue = state.defaultExchangeId ?? "binance";
        const filters = await provider.fetchSymbolFilters({ venue, symbol });
        if (!filters?.stepSize) return null;
        const n = Number.parseFloat(filters.stepSize);
        return Number.isFinite(n) && n > 0 ? n : null;
    } catch (err) {
        elizaLogger.debug(
            `[CEXWorkflow] resolveBaseStepSize failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
    }
}

function extractLlmSizes(params: Record<string, unknown> | undefined): {
    baseSize: string | undefined;
    quoteSize: string | undefined;
} {
    if (!params) return { baseSize: undefined, quoteSize: undefined };
    // Direct fields (rare — but the legacy ADK fast-path used to surface
    // them at the top level so we keep the fallback).
    const directBase =
        typeof params.base_size === "string" ? (params.base_size as string) : undefined;
    const directQuote =
        typeof params.quote_size === "string"
            ? (params.quote_size as string)
            : undefined;

    let baseSize: string | undefined = directBase;
    let quoteSize: string | undefined = directQuote;
    const orderConfig = params.order_configuration as
        | Record<string, Record<string, unknown> | undefined>
        | undefined;
    if (orderConfig) {
        for (const inner of Object.values(orderConfig)) {
            if (!inner) continue;
            if (!baseSize && typeof inner.base_size === "string") {
                baseSize = inner.base_size;
            }
            if (!quoteSize && typeof inner.quote_size === "string") {
                quoteSize = inner.quote_size;
            }
        }
    }
    return { baseSize, quoteSize };
}

/**
 * Render the locale-aware clarification body for a divergent
 * cross-check. The user's typed number is the load-bearing fact; we
 * surface BOTH numbers and ask the user to confirm.
 */
function renderCrossCheckClarification(args: {
    locale: Locale;
    userValue: number;
    userUnit: "base" | "quote";
    llmValue: number;
}): string {
    const { locale, userValue, userUnit, llmValue } = args;
    const userDisp = String(userValue);
    const llmDisp = String(llmValue);
    if (locale === "zh-CN") {
        return [
            "**等等 — 我提取的数值与你输入的不一致。**",
            "",
            `你输入的是 \`${userDisp}\` (${userUnit === "base" ? "标的数量" : "计价金额"})，`,
            `但我把它理解成 \`${llmDisp}\`。`,
            "",
            "请确认你想下的订单数量，或重新发送清晰的指令（例如 \"买 5 BTC\" 或 \"用 100 USDT 买 BTC\"）。",
        ].join("\n");
    }
    return [
        "**Hold on — the value I extracted doesn't match what you typed.**",
        "",
        `You typed \`${userDisp}\` (${userUnit === "base" ? "base asset units" : "quote / dollar units"}),`,
        `but I parsed it as \`${llmDisp}\`.`,
        "",
        "Please confirm the order size, or re-send the request more clearly (e.g. \"Buy 5 BTC\" or \"Buy with 100 USDT of BTC\").",
    ].join("\n");
}

/**
 * Fix 10 — deterministic intent cross-check. Returns a partial state
 * that short-circuits the workflow when the user's typed number
 * diverges from the LLM-extracted size; returns null when no divergence
 * (or when the provider hook isn't registered, which fails open).
 */
async function maybeRunIntentCrossCheck(
    state: CEXWorkflowStateType,
    actionCall: { action: string; userParams?: Record<string, unknown> },
): Promise<Partial<CEXWorkflowStateType> | null> {
    try {
        const provider = getCEXSpecProvider(state.runtime);
        if (!provider?.crossCheckUserIntent) return null;

        const promptText = state.message?.content?.text ?? "";
        if (!promptText) return null;

        const { baseSize, quoteSize } = extractLlmSizes(actionCall.userParams);
        if (!baseSize && !quoteSize) return null;

        // Best-effort ticker price for cross-unit normalization. We
        // intentionally reuse the same 1.5s budget as the risk pre-check
        // would; this stays cheap on the happy path because the
        // extractor never asks for the price when both sides share a
        // unit. Skip the fetch entirely for non-create actions —
        // amend/preview already carry a limit_price.
        let tickerPrice: number | undefined;
        if (
            actionCall.action === "create_order" &&
            typeof provider.fetchMarketMidUsd === "function"
        ) {
            const params = actionCall.userParams ?? {};
            const symbol =
                typeof params.product_id === "string"
                    ? (params.product_id as string)
                    : typeof params.symbol === "string"
                      ? (params.symbol as string)
                      : null;
            const venue = state.defaultExchangeId ?? "binance";
            if (symbol) {
                try {
                    const ctl = new AbortController();
                    const timer = setTimeout(() => ctl.abort(), 1_500);
                    try {
                        const mid = await provider.fetchMarketMidUsd({
                            runtime: state.runtime,
                            venue,
                            symbol,
                            signal: ctl.signal,
                        });
                        if (
                            typeof mid === "number" &&
                            Number.isFinite(mid) &&
                            mid > 0
                        ) {
                            tickerPrice = mid;
                        }
                    } finally {
                        clearTimeout(timer);
                    }
                } catch {
                    /* fail-open; cross-unit check just skips */
                }
            }
        }

        // CEX post-PR237 Commit 10 (Issue 14) — Executable price and
        // base step-size. The LLM rounds `base_size` to the venue's
        // LOT_SIZE filter using whatever price it had at extraction
        // time (typically the user's typed limit price, sometimes
        // stale ticker for market orders). To keep the cross-check
        // honest, prefer the user-typed limit price as the
        // normalization anchor and widen tolerance by one LOT_SIZE
        // step.
        const userPriceCandidate = extractLlmLimitPrice(actionCall.userParams);
        const executablePrice =
            typeof userPriceCandidate === "number" && userPriceCandidate > 0
                ? userPriceCandidate
                : null;
        const baseStepSize = await resolveBaseStepSize(state, actionCall);

        const result = provider.crossCheckUserIntent({
            promptText,
            llmBaseSize: baseSize ?? null,
            llmQuoteSize: quoteSize ?? null,
            tickerPrice: tickerPrice ?? null,
            executablePrice,
            baseStepSize,
        });
        if (!result.divergent) return null;

        const locale: Locale = state.locale ?? "en";
        const clarification = renderCrossCheckClarification({
            locale,
            userValue: result.userValue ?? 0,
            userUnit: (result.userUnit ?? "base") as "base" | "quote",
            llmValue: result.llmValueNormalized ?? 0,
        });

        elizaLogger.warn(
            `[CEXWorkflow] intent cross-check divergent userValue=${result.userValue} userUnit=${result.userUnit} llmNormalized=${result.llmValueNormalized} ratio=${result.divergenceRatio} action=${actionCall.action}`,
        );

        // Surface as a processing step against the same interrupt-type
        // bucket the approval modal uses so existing telemetry on
        // `cex_workflow_parameter_review_required` covers this case
        // without a schema change.
        emitStep(state.streamingCallback, {
            name: "intent_cross_check",
            status: "completed",
            message: "Intent cross-check surfaced a clarification",
            data: {
                type: "cex_workflow_parameter_review_required",
                reason: "intent_value_divergence",
                user_value: result.userValue,
                user_unit: result.userUnit,
                llm_value_normalized: result.llmValueNormalized,
                divergence_ratio: result.divergenceRatio,
                action: actionCall.action,
            },
        });

        getCEXSpecProvider(state.runtime)?.emitTradingEvent?.({
            stage: "clarification_request",
            userId: state.message?.userId,
            locale: state.locale,
            reason: "intent_value_divergence",
            action: actionCall.action,
        });

        return {
            llmResponse: clarification,
            parsedResponse: { isAction: false, text: clarification },
            forceFinalResponse: true,
            shouldContinue: false,
            phase: "intent_crosscheck_clarification",
        };
    } catch (err) {
        // Fail-open: a buggy cross-check must never block approvals.
        elizaLogger.warn(
            `[CEXWorkflow] intent cross-check failed (fail-open): ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
    }
}

async function requestParameterReview(state: CEXWorkflowStateType): Promise<Partial<CEXWorkflowStateType>> {
    const actionCall = state.parsedResponse?.actionCall;
    if (!actionCall) {
        return {
            hasError: true,
            errorMessage: "No action call available for parameter review",
            phase: "error",
        };
    }

    // C3 — propagate the prefix-parsed execution mode onto the action
    // params so downstream consumers (canonical intent build, paper
    // venue dispatch in `actions/shared.ts`, formatter badge) all see
    // the same mode the risk gate is about to use. Override wins over
    // any LLM-extracted `params.mode`.
    if (state.executionModeOverride) {
        const next = { ...(actionCall.userParams ?? {}) } as Record<string, unknown>;
        next.mode = state.executionModeOverride;
        actionCall.userParams = next;
    }

    // F10.4 — apply free-text-order defaults BEFORE the intent
    // cross-check + risk pre-check so all downstream gates see the
    // populated values. `applyComposeDefaults` is a no-op when the
    // request originated in the compose dialog (composedPreApproved
    // flag) or when the action doesn't take a symbol (cancel_order,
    // get_balance, etc.). Today it fills in:
    //   • product_id = BTC-USDT when missing on create/preview/amend
    //   • limit_price = 80 % of mid when a limit variant has empty price
    actionCall.userParams = await applyComposeDefaults(state, actionCall);

    const threadId = state.message.roomId;
    const userId = state.message.userId as UUID | undefined;
    if (!userId) {
        return {
            hasError: true,
            errorMessage: "User context is required for trading approval",
            phase: "parameter_review_error",
        };
    }

    // Fix 10 — deterministic intent cross-check (H-3). BEFORE risk:
    // surfaces a clarification when the user's biggest typed number
    // (e.g. "Buy 5 BTC") diverges from the LLM-extracted base_size /
    // quote_size by > MAX_VALUE_DIVERGENCE_PCT. Gated behind
    // CEX_INTENT_CROSSCHECK_ENABLED; only fires for create_order /
    // preview_order / amend_order (cancel has no size). Conservative:
    // silent unless BOTH sides have a clear value AND divergence
    // exceeds the threshold. Cross-unit comparisons (user BTC ↔ LLM
    // USDT) require a market-mid price; skip otherwise.
    const crossCheckEnabled =
        state.runtime.getSetting?.("CEX_INTENT_CROSSCHECK_ENABLED") === "true";
    const CROSS_CHECK_ACTIONS = new Set([
        "create_order",
        "preview_order",
        "amend_order",
    ]);
    if (crossCheckEnabled && CROSS_CHECK_ACTIONS.has(actionCall.action)) {
        const clarification = await maybeRunIntentCrossCheck(state, actionCall);
        if (clarification) {
            return clarification;
        }
    }

    // §1.5 risk pre-check. Deterministic gate before any human-review
    // prompt. Today this catches kill-switch + asset-blocklist; once
    // user_trading_preferences are populated it covers max-size,
    // exposure, cooldown, slippage, freshness.
    const riskOutcome = await runRiskPrecheck(state, actionCall);
    if (riskOutcome && riskOutcome.verdict !== "allow") {
        const localeForMsg: Locale = state.locale ?? "en";
        // §7.5 — every user-visible error flows through the standardized
        // contract so the chat reply carries title / body / next-step action.
        const userError = buildUserError({
            code: pickRiskBlockCode(riskOutcome.rules_fired),
            locale: localeForMsg,
            context: {
                rule: riskOutcome.rules_fired[0] ?? "risk_engine",
                explanation: riskOutcome.explanations[0] ?? "Order refused by risk gate",
            },
        });
        const text = renderUserErrorMarkdown(userError);
        emitStep(state.streamingCallback, {
            name: CEX_WORKFLOW_STEPS.riskCheck,
            status: "completed",
            message: "Risk gate blocked the request",
            data: {
                type: "trading_risk_check",
                decision: riskOutcome.verdict,
                rules_fired: riskOutcome.rules_fired,
            },
        });
        getCEXSpecProvider(state.runtime)?.emitTradingEvent?.({
            stage: "risk_check",
            userId: state.message?.userId,
            locale: state.locale,
            decision: riskOutcome.verdict,
            rules_fired: riskOutcome.rules_fired,
        });
        return {
            llmResponse: text,
            parsedResponse: { isAction: false, text },
            forceFinalResponse: true,
            shouldContinue: false,
            phase: "risk_blocked",
        };
    }
    {
        // F8 — risk-check completion is the first user-visible reassurance
        // that the gate passed; fork the copy on the resolved execution mode
        // (e.g. "Risk checks passed (paper)" so the user doesn't think a
        // live risk gate ran on a paper order).
        const riskCopy = getRiskCheckCopy({
            mode: (riskOutcome?.resolved_mode ?? state.resolvedExecutionMode) as
                | "live"
                | "paper"
                | "shadow"
                | undefined,
            locale: state.locale,
            orderSummary: resolveOrderStreamSummary(
                state.runtime,
                actionCall.action,
                actionCall.userParams as Record<string, unknown> | undefined,
            ),
        });
        emitStep(state.streamingCallback, {
            name: CEX_WORKFLOW_STEPS.riskCheck,
            status: "in_progress",
            message: riskCopy.inProgress,
            data: {
                type: "trading_risk_check",
                decision: riskOutcome?.verdict ?? "allow",
                rules_fired: riskOutcome?.rules_fired ?? [],
                mode: (riskOutcome?.resolved_mode ?? state.resolvedExecutionMode ?? "live"),
            },
        });
        emitStep(state.streamingCallback, {
            name: CEX_WORKFLOW_STEPS.riskCheck,
            status: "completed",
            message: riskCopy.completed,
            data: {
                type: "trading_risk_check",
                decision: riskOutcome?.verdict ?? "allow",
                rules_fired: riskOutcome?.rules_fired ?? [],
                mode: (riskOutcome?.resolved_mode ?? state.resolvedExecutionMode ?? "live"),
            },
        });
    }
    getCEXSpecProvider(state.runtime)?.emitTradingEvent?.({
        stage: "risk_check",
        userId: state.message?.userId,
        locale: state.locale,
        decision: riskOutcome?.verdict ?? "allow",
        rules_fired: riskOutcome?.rules_fired ?? [],
    });

    // §6.0.2 — fail-closed dep-health gate. Runs ONLY for write actions.
    // Refuses the trade when risk-audit sink, reconciliation, or market-data
    // freshness is unhealthy. Paper mode is always pass-through.
    {
        const WRITE = new Set(["create_order", "cancel_order", "amend_order", "preview_order"]);
        const isWrite = WRITE.has(actionCall.action);
        // Defense-in-depth: if the risk precheck threw (riskOutcome === null),
        // honor the public-demo paper default here too so the gate doesn't
        // fail-closed a paper demo. PUBLIC_ACCESS_MODE unset ⇒ "live" (unchanged).
        const resolvedMode = riskOutcome?.resolved_mode ?? (isPublicAccessModeActive() ? "paper" : "live");
        if (isWrite) {
            const provider = getCEXSpecProvider(state.runtime);
            const reconciliationSvc = state.runtime.getService<ITradingReconciliationService>(
                ServiceType.TRADING_RECONCILIATION,
            );
            const reconciliationHealthy =
                typeof reconciliationSvc?.isHealthy === "function"
                    ? reconciliationSvc.isHealthy(state.defaultExchangeId ?? undefined)
                    : null;
            const venueForHealth = String(
                actionCall.userParams?.exchange ??
                    actionCall.userParams?.venue ??
                    state.defaultExchangeId ??
                    "unknown",
            );
            const symbolForHealth = String(
                actionCall.userParams?.product_id ??
                    actionCall.userParams?.symbol ??
                    "unknown",
            );
            const marketDataAgeMs =
                typeof provider?.getMarketDataAgeMs === "function"
                    ? provider.getMarketDataAgeMs(venueForHealth, symbolForHealth)
                    : null;
            const health = provider?.checkTradingHealth?.({
                riskAuditWroteOk: riskOutcome?.audit_wrote_ok ?? null,
                reconciliationHealthy,
                marketDataAgeMs,
                liveFreshnessCapMs: 30_000,
                mode: resolvedMode,
                // Round-6 — cancel/amend skip the market-data freshness
                // reason; see `dependencyHealth.ts` for the rationale.
                action: actionCall.action,
            });
            if (health && !health.healthy && !health.bypassed) {
                const localeForMsg: Locale = state.locale ?? "en";
                // §7.5 — standardized contract carries title / body / action.
                // Map each HealthIssue to its corresponding catalog code so the
                // user sees the specific recovery hint (paper mode, retry in 30s,
                // adjust freshness cap) instead of a generic banner.
                const userError = buildUserError({
                    code: pickFailClosedCode(health.reasons),
                    locale: localeForMsg,
                    context: { reasons: health.reasons.join(", ") },
                });
                const failMsg = renderUserErrorMarkdown(userError);
                getCEXSpecProvider(state.runtime)?.emitTradingEvent?.({
                    stage: "fail_closed" as never,
                    userId: state.message?.userId,
                    locale: state.locale,
                    venue: state.defaultExchangeId ?? undefined,
                    reasons: health.reasons,
                });
                emitStep(state.streamingCallback, {
                    name: CEX_WORKFLOW_STEPS.riskCheck,
                    status: "completed",
                    message: "Dep-health gate refused live write",
                    data: {
                        type: "trading_fail_closed",
                        reasons: health.reasons,
                        mode: resolvedMode,
                    },
                });
                return {
                    llmResponse: failMsg,
                    parsedResponse: { isAction: false, text: failMsg },
                    forceFinalResponse: true,
                    shouldContinue: false,
                    phase: "dep_health_fail_closed",
                };
            }
        }
    }

    const normalized = injectMarginContextFromMessage(
        actionCall.action,
        normalizeTradingApprovalParams(actionCall.action, {
            ...(actionCall.userParams ?? {}),
        }),
        typeof state.message?.content?.text === "string" ? state.message.content.text : undefined,
    );

    // Expand `cancel_order` with `all_open=true` into an enumerated
    // `order_ids` list before the approval modal opens. The user asked
    // to "cancel all" but the modal would otherwise render empty ids;
    // they want to see the actual list so they can deselect specific
    // ones. Two-tier: memory (fast, free) → venue fetch (authoritative
    // but costs one REST round-trip). When both miss we leave
    // `all_open=true` and the venue cancel layer still fans out at
    // execution time, so the worst case matches today's behavior.
    if (actionCall.action === "cancel_order" && normalized) {
        try {
            const provider = getCEXSpecProvider(state.runtime);
            const venue = state.defaultExchangeId ?? null;
            const expanded = await expandCancelAllWithFallback(normalized, {
                resolveAllOrdersFromContext: provider?.resolveAllOrdersFromContext,
                fetchUserOpenOrders:
                    provider?.fetchUserOpenOrders && userId && venue
                        ? () =>
                              provider.fetchUserOpenOrders!({
                                  runtime: state.runtime,
                                  userId,
                                  venue,
                              })
                        : undefined,
                messageText:
                    typeof state.message?.content?.text === "string"
                        ? state.message.content.text
                        : "",
                locale: state.locale ?? "en",
                recentAssistantMemories: extractAssistantMemoryRecords(state),
                venue,
            });
            if (expanded.expanded) {
                normalized.order_ids = expanded.params.order_ids;
                if (typeof expanded.params.product_id === "string") {
                    normalized.product_id = expanded.params.product_id;
                }
                delete normalized.all_open;
                const idsLen = Array.isArray(normalized.order_ids)
                    ? normalized.order_ids.length
                    : 0;
                elizaLogger.info(
                    `[CEXWorkflow] cancel_order all_open expanded from ${expanded.source}: ${idsLen} order(s) on symbol=${typeof normalized.product_id === "string" ? normalized.product_id : "n/a"} (${expanded.sourceDetail})`,
                );
            }
        } catch (err) {
            elizaLogger.warn(
                `[CEXWorkflow] cancel_order all_open expansion failed (non-fatal, keeping all_open=true): ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }

    // M2 — `cancel_order` is the one action where missing `product_id` is
    // recoverable: we can look up the symbol from the assistant's recent
    // memories (which render order_id + symbol in get_orders tables) and
    // from the paper-orders / pending-orders ledgers. Without this, the
    // workflow surfaces a "requires trading pair" error on a cancel that
    // could have been completed automatically.
    if (
        actionCall.action === "cancel_order" &&
        normalized &&
        !normalized.product_id &&
        Array.isArray(normalized.order_ids) &&
        normalized.order_ids.length > 0
    ) {
        try {
            const provider = getCEXSpecProvider(state.runtime);
            const firstId = String(normalized.order_ids[0] ?? "").trim();
            const venueHint = state.defaultExchangeId ?? undefined;
            // Layer 1: scan recent assistant memos (free).
            const lookedUp = firstId && typeof provider?.resolveSymbolForOrderId === "function"
                ? provider.resolveSymbolForOrderId({
                      orderId: firstId,
                      venue: venueHint,
                      recentAssistantMemories: state.recentAssistantMemos ?? [],
                  })
                : null;
            if (lookedUp?.symbol) {
                normalized.product_id = lookedUp.symbol;
                elizaLogger.info(
                    `[CEXWorkflow] M2 cancel_order product_id resolved from recent memories: ${lookedUp.symbol} (order_id=${firstId})`,
                );
            } else {
                // Layer 2: paper_orders ledger (only worth a probe in paper mode).
                const adapter = state.runtime.databaseAdapter as unknown as {
                    paperOrdersGetById?: (
                        userId: string,
                        orderId: string,
                    ) => Promise<{ product_id?: string } | null>;
                };
                if (firstId && typeof adapter?.paperOrdersGetById === "function") {
                    const row = await adapter.paperOrdersGetById(String(userId), firstId);
                    if (row?.product_id) {
                        normalized.product_id = row.product_id;
                        elizaLogger.info(
                            `[CEXWorkflow] M2 cancel_order product_id resolved from paper_orders: ${row.product_id} (order_id=${firstId})`,
                        );
                    }
                }
                // Layer 3: pending_orders_ledger (live orders).
                if (!normalized.product_id) {
                    const reconciliationSvc = state.runtime.getService<ITradingReconciliationService>(
                        ServiceType.TRADING_RECONCILIATION,
                    );
                    const ledger = reconciliationSvc?.getLedger?.();
                    if (ledger?.getPendingOrderByClientOrderId && firstId) {
                        const row = await ledger.getPendingOrderByClientOrderId(firstId);
                        if (row?.symbol) {
                            normalized.product_id = row.symbol;
                            elizaLogger.info(
                                `[CEXWorkflow] M2 cancel_order product_id resolved from pending_orders_ledger: ${row.symbol} (order_id=${firstId})`,
                            );
                        }
                    }
                }
            }
        } catch (err) {
            elizaLogger.warn(
                `[CEXWorkflow] M2 cancel_order pair lookup failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }

    // §1.4 idempotency — replace any LLM-emitted client_order_id with
    // a deterministic derivation. Same canonical inputs → same id,
    // even across EN/ZH paraphrases.
    if (normalized && actionCall.action === "create_order") {
        try {
            const provider = getCEXSpecProvider(state.runtime);
            // §6.8 — pair client_order_id with intent_hash AND stamp the
            // workflow's stable request_id onto normalized params. Without
            // this, /user/orders rows shipped intent_hash="" / request_id=""
            // and the §6.7 replay tool couldn't join lifecycle events back
            // to the original intent.
            const derived = provider?.deriveIdempotency?.({
                action: actionCall.action,
                venue: state.defaultExchangeId ?? "binance",
                userId,
                locale: state.locale ?? "en",
                params: normalized as Record<string, unknown>,
            });
            const derivedId = derived?.client_order_id
                ?? provider?.deriveClientOrderId?.({
                    action: actionCall.action,
                    venue: state.defaultExchangeId ?? "binance",
                    userId,
                    locale: state.locale ?? "en",
                    params: normalized as Record<string, unknown>,
                });
            if (derivedId && typeof derivedId === "string") {
                const n = normalized as Record<string, unknown>;
                n.client_order_id = derivedId;
                if (derived?.intent_hash) n.intent_hash = derived.intent_hash;
                if (state.requestId) n.request_id = state.requestId;
                emitStep(state.streamingCallback, {
                    name: CEX_WORKFLOW_STEPS.idempotency,
                    status: "completed",
                    message: "Derived deterministic client_order_id",
                    data: {
                        type: "trading_idempotency",
                        client_order_id: derivedId,
                        intent_hash: derived?.intent_hash ?? null,
                        request_id: state.requestId ?? null,
                    },
                });
                provider?.emitTradingEvent?.({
                    stage: "idempotency",
                    userId,
                    locale: state.locale,
                    venue: state.defaultExchangeId ?? undefined,
                    client_order_id: derivedId,
                    intent_hash: derived?.intent_hash,
                    request_id: state.requestId,
                });
            }
        } catch (err) {
            elizaLogger.warn(
                `[CEXWorkflow] Failed to derive client_order_id: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }

    const serverOwnedBaseParams = applyServerOwnedParams(normalized, userId, state.defaultExchangeId);

    // Preview-latency optimization: kick off the venue accountSnapshot
    // fetch as soon as we have a product_id, BEFORE building the
    // approvable params / schema / capabilities. Those steps are
    // synchronous CPU work; the snapshot is a venue REST round-trip
    // (200ms–2s on Binance, sometimes longer on Coinbase). Awaiting it
    // just before `emitStep(human_input_required)` instead of inline
    // overlaps the network latency with the synchronous prep so the
    // preview modal lands as soon as the slower of the two finishes.
    let accountSnapshotPromise: Promise<
        Awaited<ReturnType<NonNullable<CEXSpecProvider["fetchAccountSnapshot"]>>>
    > | null = null;
    const accountSnapshotStartedAt = Date.now();
    if (actionCall.action === "create_order") {
        const earlyProductId =
            typeof serverOwnedBaseParams.product_id === "string"
                ? serverOwnedBaseParams.product_id
                : null;
        const split = earlyProductId ? splitCanonicalPair(earlyProductId) : null;
        if (split) {
            const provider = getCEXSpecProvider(state.runtime);
            const hasHook = typeof provider?.fetchAccountSnapshot === "function";
            elizaLogger.info(
                `[CEXWorkflow] accountSnapshot invoke productId=${earlyProductId} base=${split.base} quote=${split.quote} hasHook=${hasHook}`,
            );
            if (hasHook) {
                accountSnapshotPromise = provider!
                    .fetchAccountSnapshot!({
                        runtime: state.runtime,
                        userId,
                        venue: serverOwnedBaseParams.exchange,
                        baseAsset: split.base,
                        quoteAsset: split.quote,
                    })
                    .catch((err) => {
                        elizaLogger.warn(
                            `[CEXWorkflow] accountSnapshot fetch threw: ${
                                err instanceof Error ? err.message : String(err)
                            }`,
                        );
                        return null;
                    });
            }
        } else {
            elizaLogger.info(
                `[CEXWorkflow] accountSnapshot SKIPPED (no pair split) productId=${earlyProductId}`,
            );
        }
    }

    const actionSchema = getCEXActionSchemaForWorkflow(
        state.runtime,
        actionCall.action,
        serverOwnedBaseParams.exchange
    );
    const approvableParams = sanitizeCEXParamsBySchema(serverOwnedBaseParams, actionSchema);
    const capabilities = getCEXCapabilitiesForExchange(state.runtime, serverOwnedBaseParams.exchange);

    // Avbl / Max Buy / Est Fee data for the approval card. Best-effort:
    // skip the snapshot on any error (no creds, rate-limit, parse fail)
    // — the modal renders the order without these fields rather than
    // blocking. Only fired for create_order; cancel/preview/meta-actions
    // don't need account context at approval time.
    const accountSnapshot = accountSnapshotPromise ? await accountSnapshotPromise : null;
    const accountSnapshotLatencyMs = Date.now() - accountSnapshotStartedAt;
    if (accountSnapshotPromise) {
        elizaLogger.info(
            `[CEXWorkflow] accountSnapshot post-fetch latency_ms=${accountSnapshotLatencyMs} value=${JSON.stringify(accountSnapshot)}`,
        );
    }

    // Fix 14 — live ticker + order-book + symbol-verification enrichment
    // for the approval modal. Gated behind CEX_APPROVAL_MODAL_ENRICHMENT_ENABLED
    // so prod can flip without redeploying. Only fires for write actions
    // (create / amend / cancel / preview) and when a symbol is extractable.
    // Fail-soft: any timeout / parse / missing-hook returns no snapshot
    // and the modal renders without the live data rather than blocking.
    let marketEnrichment: MarketSnapshotResult | null = null;
    const enrichmentEnabled =
        state.runtime.getSetting?.("CEX_APPROVAL_MODAL_ENRICHMENT_ENABLED") === "true";
    if (enrichmentEnabled && APPROVAL_MODAL_ENRICHMENT_ACTIONS.has(actionCall.action)) {
        const productIdForSnapshot =
            typeof serverOwnedBaseParams?.product_id === "string"
                ? (serverOwnedBaseParams.product_id as string)
                : typeof serverOwnedBaseParams?.symbol === "string"
                  ? (serverOwnedBaseParams.symbol as string)
                  : undefined;
        const binanceSymbol = resolveBinanceSymbol(
            productIdForSnapshot,
            typeof serverOwnedBaseParams?.symbol === "string"
                ? (serverOwnedBaseParams.symbol as string)
                : undefined,
        );
        const promptText =
            typeof state.message?.content?.text === "string"
                ? state.message.content.text
                : "";
        if (binanceSymbol && promptText) {
            try {
                // CEX post-PR237 Commit 11 — thread the active venue
                // through so the modal-enrichment fetchers route to
                // the correct exchange API. Binance users see Binance
                // bid/ask; Coinbase users see Coinbase bid/ask. Falls
                // back to "binance" only when state.defaultExchangeId
                // is unset (legacy single-venue installs).
                const venue = state.defaultExchangeId ?? "binance";
                marketEnrichment = await buildMarketSnapshot({
                    provider: getCEXSpecProvider(state.runtime),
                    symbol: binanceSymbol,
                    promptText,
                    actionParams: serverOwnedBaseParams as Record<string, unknown>,
                    actionName: actionCall.action,
                    venue,
                });
                // §14e + Commit 11 — one log line per modal open,
                // structured for CloudWatch metric filters. `venue`
                // surfaces here so we can confirm the routing in
                // production logs.
                const verif = marketEnrichment.symbol_verification;
                const snap = marketEnrichment.market_snapshot;
                elizaLogger.info(
                    `[Trading] ${JSON.stringify({
                        stage: "approval_modal_enriched",
                        venue,
                        symbol: binanceSymbol,
                        snapshot_built: Boolean(snap),
                        spread_bps: snap?.spread_bps,
                        est_fill_price: snap?.est_fill_price,
                        verification_matches: verif.matches,
                    })}`,
                );
            } catch (err) {
                // Defense-in-depth — buildMarketSnapshot is documented
                // as never-throws, but the wrapper logs and swallows any
                // surprise so the approval modal still opens.
                elizaLogger.warn(
                    `[CEXWorkflow] modal enrichment failed (fail-soft): ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                );
                marketEnrichment = null;
            }
        }
    }

    // F10.2 — one-click compose path. The "Compose a trade" dialog
    // collected the explicit "I confirm these inputs are correct…" gate
    // locally before submitting, so re-rendering the same fields in a
    // second human_input_required modal is pure UX redundancy. Every
    // dangerous gate above (risk pre-check, dep-health, normalize,
    // idempotency, account+market snapshot) has already run, and every
    // gate below (executeAction's quote-freshness recheck, pre-submit
    // dedup, per-symbol lock) still runs. Only the second UI
    // confirmation is elided. Scoped to `create_order` because that's
    // the only action the compose dialog produces today; any other
    // composed action still falls through to the modal.
    const composedPreApproved = isComposePreApproved(
        state.message?.content as Record<string, unknown> | undefined,
        actionCall.action,
    );

    let decision: HumanInputDecision;
    if (composedPreApproved) {
        elizaLogger.info(
            `[CEXWorkflow] compose_preapproved skipping human_input modal userId=${userId} action=${actionCall.action}`,
        );
        getCEXSpecProvider(state.runtime)?.emitTradingEvent?.({
            stage: "approval_request",
            userId,
            locale: state.locale,
            venue: state.defaultExchangeId ?? undefined,
            approval_level: 1,
            action: actionCall.action,
            // Audit marker so trust-but-verify can flag payloads that
            // claimed compose-preapproval but originated outside the
            // dialog. The risk verdict above is the actual gate; this
            // tag just preserves provenance.
            approval_source: "compose_preapproved",
        });
        decision = {
            decision: "approved",
            confirmationLevel: 1,
            parameters: approvableParams as Record<string, unknown>,
        };
        getCEXSpecProvider(state.runtime)?.emitTradingEvent?.({
            stage: "approval_decision",
            userId,
            locale: state.locale,
            decision: "approved",
            approval_level: 1,
            approval_source: "compose_preapproved",
        });
    } else {
        // Single-confirm flow: the user reviews + authorizes in one step.
        // The HumanInputDialog renders the confirm checkbox + Submit alongside
        // the editor when confirmationsRequired === 1; the second backend
        // approval (requestParameterFinalConfirm) is skipped for write actions.
        const interruptCopy = resolveApprovalInterruptCopy(
            state.runtime,
            actionCall.action,
            approvableParams as Record<string, unknown>,
        );
        const approvalStreamCopy = getApprovalRequestCopy({
            mode: (riskOutcome?.resolved_mode ?? state.resolvedExecutionMode) as
                | "live"
                | "paper"
                | "shadow"
                | undefined,
            locale: state.locale,
            orderSummary: resolveOrderStreamSummary(
                state.runtime,
                actionCall.action,
                approvableParams as Record<string, unknown>,
            ),
        });
        const reviewApproval = waitForHumanInputApproval(state.runtime, threadId, userId, 1, {
            interruptType: "cex_workflow_parameter_review_required",
            title: interruptCopy.title,
            description: interruptCopy.description,
            confirmationsRequired: 1,
            parameters: approvableParams,
            parameterSchema: actionSchema?.parameters ?? null,
        });

        emitStep(state.streamingCallback, {
            name: CEX_WORKFLOW_STEPS.approvalRequest,
            status: "in_progress",
            message: approvalStreamCopy.inProgress,
            data: {
                type: "trading_approval_request",
                action: actionCall.action,
                mode: riskOutcome?.resolved_mode ?? state.resolvedExecutionMode ?? "live",
            },
        });

        // §4: the await branch of the decisive-signal-vs-risk-control conflict.
        setDecisionOutcome("awaiting_approval");
        emitStep(state.streamingCallback, {
            name: "human_input_required",
            status: "pending",
            message: interruptCopy.message,
            data: {
                type: "human_input_required",
                threadId: reviewApproval.request.threadId,
                approvalId: reviewApproval.request.approvalId,
                interruptType: reviewApproval.request.interruptType,
                title: interruptCopy.title,
                description: interruptCopy.description,
                confirmationsRequired: reviewApproval.request.confirmationsRequired,
                confirmationLevel: reviewApproval.request.confirmationLevel,
                fields: reviewApproval.request.parameters,
                fieldSchema: reviewApproval.request.parameterSchema,
                actionName: actionCall.action,
                capabilities,
                accountSnapshot,
                // Fix 14 — present when the enrichment block ran successfully.
                ...(marketEnrichment?.market_snapshot
                    ? { market_snapshot: marketEnrichment.market_snapshot }
                    : {}),
                ...(marketEnrichment?.symbol_verification
                    ? { symbol_verification: marketEnrichment.symbol_verification }
                    : {}),
            },
        });
        getCEXSpecProvider(state.runtime)?.emitTradingEvent?.({
            stage: "approval_request",
            userId,
            locale: state.locale,
            venue: state.defaultExchangeId ?? undefined,
            approval_level: 1,
            action: actionCall.action,
        });

        try {
            decision = await reviewApproval.promise;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const approvalStep = resolveApprovalRequestStepOutcome("failed", approvalStreamCopy, {
                failureMessage: message,
            });
            emitStep(state.streamingCallback, {
                name: CEX_WORKFLOW_STEPS.approvalRequest,
                status: approvalStep.status,
                message: approvalStep.message,
                data: {
                    type: "trading_approval_request",
                    action: actionCall.action,
                    mode: riskOutcome?.resolved_mode ?? state.resolvedExecutionMode ?? "live",
                },
            });
            getCEXSpecProvider(state.runtime)?.emitTradingEvent?.({
                stage: "approval_decision",
                userId,
                locale: state.locale,
                decision: "rejected",
                approval_level: 1,
                reason: message,
            });
            return {
                hasError: true,
                errorMessage: `Parameter review failed: ${message}`,
                phase: "parameter_review_error",
            };
        }
        const approvalStep = resolveApprovalRequestStepOutcome(
            decision.decision === "approved" ? "approved" : "rejected",
            approvalStreamCopy,
            { locale: state.locale },
        );
        emitStep(state.streamingCallback, {
            name: CEX_WORKFLOW_STEPS.approvalRequest,
            status: approvalStep.status,
            message: approvalStep.message,
            data: {
                type: "trading_approval_request",
                action: actionCall.action,
                mode: riskOutcome?.resolved_mode ?? state.resolvedExecutionMode ?? "live",
            },
        });
        getCEXSpecProvider(state.runtime)?.emitTradingEvent?.({
            stage: "approval_decision",
            userId,
            locale: state.locale,
            decision: decision.decision === "approved" ? "approved" : "rejected",
            approval_level: 1,
        });
    }

    // §6.2 — persist approval audit row. Best-effort.
    try {
        const approvalDecisionWriter = getCEXSpecProvider(state.runtime)?.writeApprovalDecision;
        if (typeof approvalDecisionWriter === "function") {
            await approvalDecisionWriter({
                request_id: String(state.requestId ?? state.message.id ?? ""),
                userId,
                level: 1,
                decision: decision.decision === "approved" ? "approved" : "rejected",
                presented_summary: approvableParams as Record<string, unknown>,
            });
        }
    } catch (err) {
        elizaLogger.warn(
            `[CEXWorkflow] writeApprovalDecision (level=1) failed: ${
                err instanceof Error ? err.message : String(err)
            }`,
        );
    }

    if (decision.decision !== "approved") {
        // Fix-T13 diagnostic (post-PR238 UI iter): T13 "Buy 0.001 BTC at
        // 80000" reproducibly resolves here without the user clicking
        // Cancel. Logging the rejection feedback + the LLM-extracted
        // sizes so the next deploy reveals which subsystem set
        // decision.decision = "rejected" (kill switch, SSE close, or a
        // racing approval replacement).
        elizaLogger.warn(
            `[CEXWorkflow] parameter_review_rejected userId=${userId} action=${actionCall.action} feedback=${decision.feedback ?? "(none)"} llm_base_size=${(actionCall.userParams as Record<string, unknown> | undefined)?.base_size ?? "(none)"} llm_quote_size=${(actionCall.userParams as Record<string, unknown> | undefined)?.quote_size ?? "(none)"} prompt="${String(state.message?.content?.text ?? "").slice(0, 200)}"`,
        );
        const canceled = state.locale === "zh-CN" ? "已取消本次请求。" : "Request cancelled.";
        return {
            llmResponse: canceled,
            parsedResponse: { isAction: false, text: canceled },
            forceFinalResponse: true,
            shouldContinue: false,
            phase: "parameter_review_rejected",
        };
    }

    const decisionParams = isRecord(decision.parameters) ? decision.parameters : approvableParams;
    const normalizedDecisionParams = normalizeTradingApprovalParams(actionCall.action, decisionParams);
    const sanitizedDecisionParams = sanitizeCEXParamsBySchema(
        stripServerOwnedParams(normalizedDecisionParams),
        actionSchema
    );
    const userParamsWithExchange = applyServerOwnedParams(
        { ...serverOwnedBaseParams, ...sanitizedDecisionParams },
        userId,
        state.defaultExchangeId
    );

    try {
        getCEXSpecProvider(state.runtime)?.validateApprovedActionParams?.(
            actionCall.action,
            userParamsWithExchange as Record<string, unknown>
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            hasError: true,
            errorMessage: `Invalid trading parameters: ${message}`,
            phase: "parameter_review_validation_error",
        };
    }

    // Fix 11 (H-4) — capture the approved_mid + timestamp so
    // `executeAction` can re-fetch a fresh tick on Confirm and compare
    // drift. `riskOutcome.market_mid_usd` is the same mid the
    // priceDeviation rule evaluated against; persisting it here means
    // the Confirm-time drift check is anchored on the EXACT number
    // the user reviewed, not a re-derived one. Build the state patch
    // conditionally so we don't overwrite with `undefined` when the
    // ticker lookup was unavailable.
    const approvalPatch: Partial<CEXWorkflowStateType> = {
        approvedActionCall: {
            action: actionCall.action,
            userParams: userParamsWithExchange,
        },
        // F1 — stamp the resolved mode onto workflow state so the formatter
        // (and any downstream stages) can fork copy without re-deriving.
        // `riskOutcome` is computed at the top of this function via
        // `runRiskPrecheck`; its `resolved_mode` field is the same one
        // the §6.0.2 fail-closed gate reads. Fallback default = "live"
        // (or "paper" under PUBLIC_ACCESS_MODE so a public-demo order never
        // executes as live when the precheck was unavailable).
        resolvedExecutionMode: (riskOutcome?.resolved_mode ??
            (isPublicAccessModeActive() ? "paper" : "live")) as
            | "live"
            | "paper"
            | "shadow",
        approvedAtMs: Date.now(),
        phase: "parameter_review_approved",
    };
    if (typeof riskOutcome?.market_mid_usd === "number") {
        approvalPatch.approvedMarketMid = riskOutcome.market_mid_usd;
    }
    return approvalPatch;
}

async function requestParameterFinalConfirm(state: CEXWorkflowStateType): Promise<Partial<CEXWorkflowStateType>> {
    const approved = state.approvedActionCall;
    if (!approved) {
        return {
            hasError: true,
            errorMessage: "No approved action call available for final confirmation",
            phase: "error",
        };
    }

    const threadId = state.message.roomId;
    const userId = state.message.userId as UUID | undefined;
    if (!userId) {
        return {
            hasError: true,
            errorMessage: "User context is required for trading approval",
            phase: "parameter_final_confirm_error",
        };
    }
    const paramsForExecutionBase = applyServerOwnedParams(approved.userParams, userId, state.defaultExchangeId);
    const finalActionSchema = getCEXActionSchemaForWorkflow(
        state.runtime,
        approved.action,
        paramsForExecutionBase.exchange
    );
    const paramsForConfirm = sanitizeCEXParamsBySchema(paramsForExecutionBase, finalActionSchema);

    const summary = {
        exchange: paramsForExecutionBase.exchange ?? paramsForExecutionBase.venue ?? paramsForExecutionBase.platform,
        symbol:
            paramsForExecutionBase.product_id ??
            paramsForExecutionBase.symbol ??
            paramsForExecutionBase.instrument,
        order_id: paramsForExecutionBase.order_id,
        trade_id: paramsForExecutionBase.trade_id,
        position_id: paramsForExecutionBase.position_id,
        from: paramsForExecutionBase.from ?? paramsForExecutionBase.start_date,
        to: paramsForExecutionBase.to ?? paramsForExecutionBase.end_date,
    };

    const finalCapabilities = getCEXCapabilitiesForExchange(state.runtime, paramsForExecutionBase.exchange);

    const finalApproval = waitForHumanInputApproval(state.runtime, threadId, userId, 2, {
        interruptType: "cex_workflow_parameter_final_confirm_required",
        title: "Authorize execution",
        description: "You are confirming an irreversible trading action",
        confirmationsRequired: 2,
        parameters: paramsForConfirm,
        parameterSchema: finalActionSchema?.parameters ?? null,
        summary,
    });

    // §4: the L2 await branch (second confirmation) of the conflict.
    setDecisionOutcome("awaiting_approval");
    emitStep(state.streamingCallback, {
        name: "human_input_confirm_required",
        status: "pending",
        message: "Please confirm again to run the trading query.",
        data: {
            type: "human_input_confirm_required",
            threadId: finalApproval.request.threadId,
            approvalId: finalApproval.request.approvalId,
            interruptType: finalApproval.request.interruptType,
            title: finalApproval.request.title,
            description: finalApproval.request.description,
            confirmationsRequired: finalApproval.request.confirmationsRequired,
            confirmationLevel: finalApproval.request.confirmationLevel,
            fields: finalApproval.request.parameters,
            fieldSchema: finalApproval.request.parameterSchema,
            summary: finalApproval.request.summary,
            actionName: approved.action,
            capabilities: finalCapabilities,
        },
    });

    let decision: HumanInputDecision;
    try {
        decision = await finalApproval.promise;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            hasError: true,
            errorMessage: `Final confirmation failed: ${message}`,
            phase: "parameter_final_confirm_error",
        };
    }

    // §6.2 — persist level-2 approval audit row regardless of decision.
    try {
        const approvalDecisionWriter = getCEXSpecProvider(state.runtime)?.writeApprovalDecision;
        if (typeof approvalDecisionWriter === "function") {
            await approvalDecisionWriter({
                request_id: String(state.requestId ?? state.message.id ?? ""),
                userId,
                level: 2,
                decision: decision.decision === "approved" ? "approved" : "rejected",
                presented_summary: paramsForConfirm as Record<string, unknown>,
            });
        }
    } catch (err) {
        elizaLogger.warn(
            `[CEXWorkflow] writeApprovalDecision (level=2) failed: ${
                err instanceof Error ? err.message : String(err)
            }`,
        );
    }

    if (decision.decision !== "approved") {
        const canceled = state.locale === "zh-CN" ? "已取消本次请求。" : "Request cancelled.";
        return {
            llmResponse: canceled,
            parsedResponse: { isAction: false, text: canceled },
            forceFinalResponse: true,
            shouldContinue: false,
            phase: "parameter_final_confirm_rejected",
        };
    }

    const decisionParams = isRecord(decision.parameters) ? decision.parameters : paramsForConfirm;
    const normalizedDecisionParams = normalizeTradingApprovalParams(approved.action, decisionParams);
    const sanitizedDecisionParams = sanitizeCEXParamsBySchema(
        stripServerOwnedParams(normalizedDecisionParams),
        finalActionSchema
    );
    const userParamsWithExchange = applyServerOwnedParams(
        { ...paramsForExecutionBase, ...sanitizedDecisionParams },
        userId,
        state.defaultExchangeId
    );

    return {
        approvedActionCall: {
            action: approved.action,
            userParams: userParamsWithExchange,
        },
        phase: "parameter_final_confirm_approved",
    };
}

/**
 * §1.2 stake-aware fast path. For read-only actions (`get_balance`,
 * `get_orders`, `get_fills`), skip the two-step human-approval gate
 * entirely. Sanitize the params and feed them to the existing
 * executeAction node.
 */
async function prepareReadOnlyAction(
    state: CEXWorkflowStateType,
): Promise<Partial<CEXWorkflowStateType>> {
    const actionCall = state.parsedResponse?.actionCall;
    if (!actionCall) {
        return {
            hasError: true,
            errorMessage: "No action call available for read-only fast path",
            phase: "error",
        };
    }
    const userId = state.message.userId as UUID | undefined;
    if (!userId) {
        return {
            hasError: true,
            errorMessage: "User context is required for read-only action",
            phase: "read_only_fast_path_error",
        };
    }
    const normalized = injectMarginContextFromMessage(
        actionCall.action,
        normalizeTradingApprovalParams(actionCall.action, {
            ...(actionCall.userParams ?? {}),
        }),
        typeof state.message?.content?.text === "string" ? state.message.content.text : undefined,
    );
    const baseParams = applyServerOwnedParams(normalized, userId, state.defaultExchangeId);
    const schema = getCEXActionSchemaForWorkflow(
        state.runtime,
        actionCall.action,
        baseParams.exchange,
    );
    // Sanitize against schema, but re-apply server-owned params so the
    // action handler receives `userId` + `exchange` (both schema-marked
    // `injected: true` and therefore stripped by default sanitization).
    // The approval path does the same re-apply post-decision.
    const sanitized = sanitizeCEXParamsBySchema(baseParams, schema);
    const userParamsForExecute = applyServerOwnedParams(
        sanitized,
        userId,
        state.defaultExchangeId,
    );

    try {
        getCEXSpecProvider(state.runtime)?.validateApprovedActionParams?.(
            actionCall.action,
            userParamsForExecute as Record<string, unknown>,
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            hasError: true,
            errorMessage: `Invalid read-only action parameters: ${message}`,
            phase: "read_only_fast_path_validation_error",
        };
    }

    emitStep(state.streamingCallback, {
        name: CEX_WORKFLOW_STEPS.stakeCheck,
        status: "completed",
        message: `Read-only action — bypassing approval (${actionCall.action})`,
        data: {
            type: "trading_stake_check",
            // H3b — same wire-rename rationale as the preprocess event.
            // `stake` retained for one release of compatibility; new
            // consumers should read `tool_capability` instead.
            stake: "read_only",
            tool_capability: "read_only",
            action: actionCall.action,
        },
    });

    return {
        approvedActionCall: {
            action: actionCall.action,
            userParams: userParamsForExecute,
        },
        // F1 — read-only fast path: mode never matters for reads, but we
        // still stamp "live" so the formatter has a defined value and the
        // mechanical badge prefix doesn't fire spuriously.
        resolvedExecutionMode: "live",
        phase: "read_only_fast_path_approved",
    };
}

/**
 * Fix 11 (H-4) — quote-freshness re-check on Confirm.
 *
 * After the user clicked Submit in the parameter-review modal, the
 * market may have moved (median time-on-modal is 5–30 s; 99p > 60 s).
 * `priceDeviation` + `slippageCap` already ran against the
 * approved_mid; if the latest mid is now far from that, the approved
 * order is no longer the order the user thought they were placing.
 *
 * Return shape:
 *  - `ok: true`  → drift within cap (or skipped — see below).
 *      `latest_mid` / `drift_bps` populated when a fresh quote was
 *      obtained.
 *  - `ok: false` → drift exceeds cap, caller MUST abort with `reason`.
 *
 * Skipped (returns `ok: true`) when:
 *  - The approved action is not `create_order` (no limit price to
 *    compare).
 *  - `approvedMarketMid` is missing (review-time ticker failed —
 *    nothing to compare against).
 *  - The `fetchMarketMidUsd` provider hook isn't registered.
 *  - The fresh-quote fetch fails (fail-soft — block-on-fetch-failure
 *    would erode user trust more than the marginal staleness risk).
 */
export const FIX11_DEFAULT_CAP_BPS = 100;
export const FIX11_DEFAULT_CAP_PCT = FIX11_DEFAULT_CAP_BPS / 10_000;

export async function recheckQuoteFreshness(args: {
    state: CEXWorkflowStateType;
    venue: string;
    symbol: string;
    approvedMid: number;
    approvedAtMs: number;
}): Promise<{
    ok: boolean;
    reason?: string;
    latest_mid?: number;
    drift_bps?: number;
}> {
    const { state, venue, symbol, approvedMid, approvedAtMs } = args;
    if (!Number.isFinite(approvedMid) || approvedMid <= 0) return { ok: true };

    const provider = getCEXSpecProvider(state.runtime);
    if (typeof provider?.fetchMarketMidUsd !== "function") return { ok: true };

    // Fresh-quote fetch (1.5 s budget). Fail-soft: any error → proceed.
    let latestMid: number | null = null;
    try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 1_500);
        try {
            latestMid = await provider.fetchMarketMidUsd({
                runtime: state.runtime,
                venue,
                symbol,
                signal: ctl.signal,
                bypassCache: true,
            });
        } finally {
            clearTimeout(timer);
        }
    } catch (err) {
        elizaLogger.warn(
            `[CEXWorkflow] Fix 11 fresh-quote fetch failed (fail-soft): ${
                err instanceof Error ? err.message : String(err)
            }`,
        );
        return { ok: true };
    }
    if (typeof latestMid !== "number" || !Number.isFinite(latestMid) || latestMid <= 0) {
        return { ok: true };
    }

    // Cap = min(intent.execution_constraints.price_deviation_max_pct,
    //           preferences.price_deviation_max_pct) — user-provided
    // overrides can only tighten. Default 100 bps when both absent.
    let prefsCap: number | undefined;
    try {
        const adapter = state.runtime.databaseAdapter as unknown as {
            getUserTradingPreferences?: (id: string) => Promise<unknown>;
        };
        if (typeof adapter.getUserTradingPreferences === "function") {
            const fetched = (await adapter.getUserTradingPreferences(
                String(state.message.userId ?? ""),
            )) as { price_deviation_max_pct?: number } | null;
            if (
                fetched &&
                typeof fetched.price_deviation_max_pct === "number" &&
                Number.isFinite(fetched.price_deviation_max_pct)
            ) {
                prefsCap = fetched.price_deviation_max_pct;
            }
        }
    } catch {
        /* fail-open; fall back to default */
    }
    const params = state.approvedActionCall?.userParams as
        | { execution_constraints?: { price_deviation_max_pct?: number } }
        | undefined;
    const intentCap =
        typeof params?.execution_constraints?.price_deviation_max_pct === "number" &&
        Number.isFinite(params.execution_constraints.price_deviation_max_pct)
            ? params.execution_constraints.price_deviation_max_pct
            : undefined;
    let cap: number;
    if (prefsCap !== undefined && intentCap !== undefined) cap = Math.min(prefsCap, intentCap);
    else if (prefsCap !== undefined) cap = prefsCap;
    else if (intentCap !== undefined) cap = intentCap;
    else cap = FIX11_DEFAULT_CAP_PCT;

    const driftPct = Math.abs(latestMid - approvedMid) / approvedMid;
    const driftBps = driftPct * 10_000;
    if (driftPct > cap) {
        const elapsedSec = Math.max(0, Math.round((Date.now() - approvedAtMs) / 1000));
        const driftBpsRounded = Math.round(driftBps * 10) / 10;
        const reason =
            state.locale === "zh-CN"
                ? `市场在你审核此订单后的 ${elapsedSec} 秒内已变动 ${driftBpsRounded.toFixed(1)} bps，如仍要继续，请重新提交。`
                : `Market moved ${driftBpsRounded.toFixed(1)} bps in the ${elapsedSec} seconds since you reviewed this order. Re-submit if you still want to proceed.`;
        return { ok: false, reason, latest_mid: latestMid, drift_bps: driftBps };
    }

    // Drift within cap — re-run the `priceDeviation` + `slippageCap`
    // rules against the FRESH mid + `market_data_age_ms = 0`. Cheap
    // (pure-function evaluation); proceeds only if both pass. Anything
    // else (provider missing, hook throws) fails open — drift is the
    // primary safety net.
    try {
        const provider = getCEXSpecProvider(state.runtime);
        if (typeof provider?.runRiskPrecheck === "function" && state.approvedActionCall) {
            const userId = String(state.message.userId ?? "");
            const venueForRecheck = String(
                state.approvedActionCall.userParams?.exchange ??
                    state.approvedActionCall.userParams?.venue ??
                    venue,
            );
            const decision = await provider.runRiskPrecheck({
                action: state.approvedActionCall.action,
                venue: venueForRecheck,
                userId,
                locale: state.locale ?? "en",
                params: state.approvedActionCall.userParams ?? {},
                mode: state.resolvedExecutionMode ?? "live",
                market_mid_usd: latestMid,
                market_data_age_ms: 0,
                rules_to_run: ["priceDeviation", "slippageCap"],
            });
            if (decision && decision.verdict !== "allow") {
                const elapsedSec = Math.max(0, Math.round((Date.now() - approvedAtMs) / 1000));
                const driftBpsRounded = Math.round(driftBps * 10) / 10;
                const explanation = decision.explanations?.[0] ?? "risk gate refused on fresh quote";
                const reason =
                    state.locale === "zh-CN"
                        ? `市场在你审核此订单后的 ${elapsedSec} 秒内已变动 ${driftBpsRounded.toFixed(1)} bps，如仍要继续，请重新提交。（${explanation}）`
                        : `Market moved ${driftBpsRounded.toFixed(1)} bps in the ${elapsedSec} seconds since you reviewed this order. Re-submit if you still want to proceed. (${explanation})`;
                return { ok: false, reason, latest_mid: latestMid, drift_bps: driftBps };
            }
        }
    } catch (err) {
        elizaLogger.warn(
            `[CEXWorkflow] Fix 11 rules-filtered re-check failed (fail-soft): ${
                err instanceof Error ? err.message : String(err)
            }`,
        );
    }
    return { ok: true, latest_mid: latestMid, drift_bps: driftBps };
}

async function executeAction(state: CEXWorkflowStateType): Promise<Partial<CEXWorkflowStateType>> {
    const approved = state.approvedActionCall;
    if (!approved) {
        return {
            hasError: true,
            errorMessage: "No approved action call available for execution",
            phase: "error",
        };
    }

    // Fix 11 (H-4) — quote-freshness re-check. The slippage / price-
    // deviation rules ran at parameter-review time against the
    // `approvedMarketMid`; if the market moved while the user read
    // the modal, the approved order is stale. Only fires for
    // `create_order` (cancel/preview carry no limit price), only
    // when we have an `approvedMarketMid` to compare against, and
    // only when the feature flag is on.
    const recheckEnabled =
        state.runtime.getSetting?.("CEX_CONFIRM_QUOTE_RECHECK_ENABLED") === "true";
    if (
        recheckEnabled &&
        approved.action === "create_order" &&
        typeof state.approvedMarketMid === "number"
    ) {
        const symbol =
            typeof approved.userParams?.product_id === "string"
                ? (approved.userParams.product_id as string)
                : typeof approved.userParams?.symbol === "string"
                  ? (approved.userParams.symbol as string)
                  : null;
        const venue = String(
            approved.userParams?.exchange ??
                approved.userParams?.venue ??
                state.defaultExchangeId ??
                "binance",
        );
        if (symbol) {
            const recheck = await recheckQuoteFreshness({
                state,
                venue,
                symbol,
                approvedMid: state.approvedMarketMid,
                approvedAtMs: state.approvedAtMs ?? Date.now(),
            });
            if (!recheck.ok && recheck.reason) {
                emitStep(state.streamingCallback, {
                    name: CEX_WORKFLOW_STEPS.riskCheck,
                    status: "completed",
                    message: "Quote-freshness re-check blocked the request",
                    data: {
                        type: "trading_quote_freshness_block",
                        approved_mid: state.approvedMarketMid,
                        latest_mid: recheck.latest_mid,
                        drift_bps: recheck.drift_bps,
                    },
                });
                getCEXSpecProvider(state.runtime)?.emitTradingEvent?.({
                    stage: "risk_check",
                    userId: state.message?.userId,
                    locale: state.locale,
                    decision: "block",
                    rules_fired: ["quoteFreshness"],
                });
                return {
                    llmResponse: recheck.reason,
                    parsedResponse: { isAction: false, text: recheck.reason },
                    forceFinalResponse: true,
                    shouldContinue: false,
                    phase: "quote_freshness_block",
                };
            }
        }
    }

    emitStep(state.streamingCallback, {
        name: "cex_workflow_execute_action",
        status: "in_progress",
        message: `Executing action: ${approved.action}`,
        data: {
            type: "trading_execute_action",
            action: approved.action,
        },
    });

    const WRITE_ACTIONS = new Set(["create_order", "cancel_order", "amend_order"]);
    const isWriteAction = WRITE_ACTIONS.has(approved.action);

    let releaseLock: (() => void) | null = null;
    if (isWriteAction) {
        const reconciliationSvc = state.runtime.getService<ITradingReconciliationService>(
            ServiceType.TRADING_RECONCILIATION
        );

        // §6.0.1 — pre-submit ledger dedup. Refuse new venue submits when a
        // row exists for this `client_order_id` in any non-terminal state.
        // Only applies to create_order; cancel/amend already target an
        // existing venue order by ID.
        if (
            approved.action === "create_order" &&
            reconciliationSvc &&
            typeof reconciliationSvc.getLedger === "function"
        ) {
            const ledger = reconciliationSvc.getLedger();
            const provider = getCEXSpecProvider(state.runtime);
            const clientOrderId = String(
                state.approvedActionCall?.userParams?.client_order_id ?? "",
            );
            if (ledger && clientOrderId && typeof provider?.checkExistingOrder === "function") {
                try {
                    const activeParams = {
                        ...(state.approvedActionCall?.userParams ?? {}),
                    } as Record<string, unknown>;
                    let activeClientOrderId = clientOrderId;
                    let dedupOverrideAttempts = 0;

                    // eslint-disable-next-line no-constant-condition
                    while (true) {
                        const dedup = await provider.checkExistingOrder(
                            ledger,
                            activeClientOrderId,
                        );
                        if (dedup.kind === "new") break;

                        dedupOverrideAttempts += 1;
                        if (dedupOverrideAttempts > MAX_DEDUP_OVERRIDE_ATTEMPTS) {
                            return {
                                hasError: true,
                                errorMessage:
                                    "Exceeded maximum dedup override attempts; could not derive a new client order ID",
                                phase: "presubmit_dedup_error",
                            };
                        }

                        const submitVenue = String(
                            activeParams.exchange ?? activeParams.venue ?? "unknown",
                        );
                        const submitSymbol = String(
                            activeParams.product_id ?? activeParams.symbol ?? "unknown",
                        );
                        provider?.emitTradingEvent?.({
                            stage: "idempotency_hit" as never,
                            userId: state.message.userId,
                            venue: submitVenue,
                            symbol: submitSymbol,
                            client_order_id: activeClientOrderId,
                            existing_state: dedup.order.state,
                            locale: state.locale,
                        });
                        const locale: Locale = state.locale ?? "en";
                        const dedupKind = dedup.kind as DedupKind;
                        const existingSummary = buildDedupExistingOrderSummary(
                            dedup.order,
                        );
                        const dedupContext = buildDedupContext(
                            dedupKind,
                            existingSummary,
                            locale,
                        );

                        emitStep(state.streamingCallback, {
                            name: CEX_WORKFLOW_STEPS.idempotency,
                            status: "in_progress",
                            message: dedupContext.warning,
                            data: {
                                type: "trading_idempotency_hit",
                                client_order_id: activeClientOrderId,
                                kind: dedup.kind,
                                existing_state: dedup.order.state,
                            },
                        });

                        const threadId = state.message.roomId;
                        const userId = state.message.userId as UUID | undefined;
                        if (!userId) {
                            return {
                                hasError: true,
                                errorMessage: "User context is required for dedup override approval",
                                phase: "presubmit_dedup_error",
                            };
                        }

                        const dedupApproval = waitForHumanInputApproval(
                            state.runtime,
                            threadId,
                            userId,
                            1,
                            {
                                interruptType: "cex_dedup_override_required",
                                title: dedupApprovalTitleForKind(dedupKind, locale),
                                description: dedupApprovalDescription(
                                    existingSummary,
                                    dedupKind,
                                    locale,
                                ),
                                confirmationsRequired: 1,
                                parameters: {},
                                parameterSchema: null,
                            },
                        );

                        // §4: in-execution dedup re-gate — another await branch of the conflict.
                        setDecisionOutcome("awaiting_approval");
                        emitStep(state.streamingCallback, {
                            name: "human_input_required",
                            status: "pending",
                            message: dedupContext.warning,
                            data: {
                                type: "human_input_required",
                                threadId: dedupApproval.request.threadId,
                                approvalId: dedupApproval.request.approvalId,
                                interruptType: dedupApproval.request.interruptType,
                                title: dedupContext.title,
                                description: dedupApproval.request.description,
                                confirmationsRequired:
                                    dedupApproval.request.confirmationsRequired,
                                confirmationLevel:
                                    dedupApproval.request.confirmationLevel,
                                fields: {},
                                fieldSchema: null,
                                actionName: "create_order",
                                dedup_context: dedupContext,
                            },
                        });

                        let decision: HumanInputDecision;
                        try {
                            decision = await dedupApproval.promise;
                        } catch (error) {
                            const message =
                                error instanceof Error ? error.message : String(error);
                            emitStep(state.streamingCallback, {
                                name: CEX_WORKFLOW_STEPS.idempotency,
                                status: "error",
                                message,
                                data: {
                                    type: "trading_idempotency_hit",
                                    client_order_id: activeClientOrderId,
                                    kind: dedup.kind,
                                },
                            });
                            return {
                                hasError: true,
                                errorMessage: `Dedup override approval failed: ${message}`,
                                phase: "presubmit_dedup_error",
                            };
                        }

                        if (decision.decision !== "approved") {
                            emitStep(state.streamingCallback, {
                                name: CEX_WORKFLOW_STEPS.idempotency,
                                status: "error",
                                message:
                                    locale === "zh-CN"
                                        ? "已拒绝重复订单覆盖"
                                        : "Duplicate override declined",
                                data: {
                                    type: "trading_idempotency_hit",
                                    client_order_id: activeClientOrderId,
                                    kind: dedup.kind,
                                },
                            });
                            const declined = dedupDeclinedMessage(locale);
                            return {
                                llmResponse: declined,
                                parsedResponse: { isAction: false, text: declined },
                                forceFinalResponse: true,
                                shouldContinue: false,
                                phase: "presubmit_dedup_declined",
                            };
                        }

                        emitStep(state.streamingCallback, {
                            name: CEX_WORKFLOW_STEPS.idempotency,
                            status: "completed",
                            message:
                                locale === "zh-CN"
                                    ? "已确认 — 将使用新的客户端订单 ID 提交"
                                    : "Override approved — submitting with new client order ID",
                            data: {
                                type: "trading_idempotency_hit",
                                client_order_id: activeClientOrderId,
                                kind: dedup.kind,
                                existing_state: dedup.order.state,
                            },
                        });

                        const resubmitNonce = uuidv4();
                        const paramsForDerivation = {
                            ...activeParams,
                            _idempotency_resubmit_nonce: resubmitNonce,
                        };
                        const derived = provider?.deriveIdempotency?.({
                            action: "create_order",
                            venue: submitVenue,
                            userId: String(userId),
                            locale,
                            params: paramsForDerivation,
                        });
                        const derivedId =
                            derived?.client_order_id ??
                            provider?.deriveClientOrderId?.({
                                action: "create_order",
                                venue: submitVenue,
                                userId: String(userId),
                                locale,
                                params: paramsForDerivation,
                            });
                        if (!derivedId || typeof derivedId !== "string") {
                            return {
                                hasError: true,
                                errorMessage:
                                    "Failed to derive a new client_order_id after dedup override",
                                phase: "presubmit_dedup_error",
                            };
                        }
                        activeParams.client_order_id = derivedId;
                        if (derived?.intent_hash) {
                            activeParams.intent_hash = derived.intent_hash;
                        }
                        activeClientOrderId = derivedId;
                        approved.userParams = activeParams;
                    }
                } catch (err) {
                    elizaLogger.warn(
                        `[CEXWorkflow] pre-submit dedup probe failed: ${
                            err instanceof Error ? err.message : String(err)
                        }`,
                    );
                }
            }
        }

        // Order-submit observability: emit after dedup override so
        // client_order_id reflects the final derived ID.
        if (approved.action === "create_order") {
            const dispVenue = String(
                approved.userParams?.exchange ?? approved.userParams?.venue ?? "unknown",
            );
            const dispSymbol = String(
                approved.userParams?.product_id ?? approved.userParams?.symbol ?? "unknown",
            );
            const dispCid = String(approved.userParams?.client_order_id ?? "");
            getCEXSpecProvider(state.runtime)?.emitTradingEvent?.({
                stage: "order_dispatch_attempt" as never,
                userId: state.message.userId,
                venue: dispVenue,
                symbol: dispSymbol,
                client_order_id: dispCid || undefined,
                locale: state.locale,
            });
        }

        if (reconciliationSvc) {
            const venue = String(state.approvedActionCall?.userParams?.exchange ?? state.approvedActionCall?.userParams?.venue ?? "unknown");
            const symbol = String(state.approvedActionCall?.userParams?.product_id ?? state.approvedActionCall?.userParams?.symbol ?? "unknown");
            const lockAcquireStart = Date.now();
            releaseLock = await reconciliationSvc.acquireOrderLock(state.message.userId, venue, symbol);
            const waited_ms = Date.now() - lockAcquireStart;
            emitStep(state.streamingCallback, {
                name: CEX_WORKFLOW_STEPS.lockAcquire,
                status: "in_progress",
                message: `Acquired trading lock for ${venue}:${symbol}`,
                data: { type: "trading_lock_acquire", venue, symbol },
            });
            getCEXSpecProvider(state.runtime)?.emitTradingEvent?.({
                stage: "lock_acquire",
                userId: state.message.userId,
                venue,
                symbol,
                waited_ms,
            });
        }
    }
    const orderSubmitStart = Date.now();
    {
        const submitVenue = String(state.approvedActionCall?.userParams?.exchange ?? state.approvedActionCall?.userParams?.venue ?? "unknown");
        const submitSymbol = String(state.approvedActionCall?.userParams?.product_id ?? state.approvedActionCall?.userParams?.symbol ?? "unknown");
        const submitClientId = String(state.approvedActionCall?.userParams?.client_order_id ?? "");
        if (approved.action === "create_order") {
            getCEXSpecProvider(state.runtime)?.emitTradingEvent?.({
                stage: "order_submit",
                userId: state.message.userId,
                venue: submitVenue,
                symbol: submitSymbol,
                client_order_id: submitClientId || undefined,
                locale: state.locale,
            });
            // F8 — emit a user-facing stream step with mode-aware copy at
            // the venue-call boundary. Paper mode must never say "exchange".
            const submitCopy = getOrderSubmitCopy({
                mode: state.resolvedExecutionMode,
                locale: state.locale,
                orderSummary: resolveOrderStreamSummary(
                    state.runtime,
                    approved.action,
                    approved.userParams as Record<string, unknown> | undefined,
                ),
            });
            emitStep(state.streamingCallback, {
                name: CEX_WORKFLOW_STEPS.orderSubmit,
                status: "in_progress",
                message: submitCopy.inProgress,
                data: {
                    type: "trading_order_submit",
                    mode: state.resolvedExecutionMode ?? "live",
                    venue: submitVenue,
                    symbol: submitSymbol,
                    client_order_id: submitClientId || undefined,
                    notional_usd: orderSubmitNotionalUsd(approved.userParams as Record<string, unknown> | undefined),
                },
            });
        }
    }

    try {
        const tradingActions = getCEXActions(state.runtime);
        const action = tradingActions.find((a: Action) => a.name === approved.action);
        if (!action) {
            throw new Error(`Action not found: ${approved.action}`);
        }

        const dataRetention = await getDataRetentionConfig(state.runtime, state.message.userId);

        // Use the user's original message text as the synthetic memory
        // content so meta-actions (compile_strategy, run_backtest,
        // set_trading_mode) can read the NL strategy / mode description
        // from memory.content.text instead of the placeholder
        // "Execute <action>" string. Falls back to placeholder when the
        // original is unavailable.
        const originalUserText = state.message?.content?.text ?? "";
        const actionMemoryText = originalUserText || `Execute ${approved.action}`;
        const actionMemory: Memory = {
            id: uuidv4() as UUID,
            userId: state.runtime.agentId,
            agentId: state.runtime.agentId,
            content: {
                text: actionMemoryText,
                action: approved.action,
                ...approved.userParams,
            },
            roomId: state.message.roomId,
            createdAt: Date.now(),
        };
        const userParams: Record<string, unknown> = {
            ...(approved.userParams ?? {}),
            ...dataRetention,
        };

        // §6.3 — wrap the action invocation in an async-scoped venue-call
        // context so binance.ts / coinbase.ts pick up request_id /
        // intent_hash / userId / client_order_id and attach them to every
        // `venue_calls` row + `[Trading] venue_call` event.
        const venueCtx = {
            request_id: state.requestId,
            intent_hash: typeof approved.userParams?.intent_hash === "string"
                ? approved.userParams.intent_hash
                : undefined,
            userId: state.message.userId,
            client_order_id: typeof approved.userParams?.client_order_id === "string"
                ? approved.userParams.client_order_id
                : undefined,
        };
        const runInVenueCtx = getCEXSpecProvider(state.runtime)?.runWithVenueCallContext;
        const invokeAction = (): Promise<unknown> => new Promise<unknown>((resolve, reject) => {
            let callbackCalled = false;
            let callbackResult: Content | null = null;

            const callback: HandlerCallback = async (content) => {
                callbackCalled = true;
                const metadata = (content && typeof content === "object" && "metadata" in content
                    && typeof (content as Record<string, unknown>).metadata === "object"
                    && (content as Record<string, unknown>).metadata !== null)
                    ? (content as Record<string, unknown>).metadata as Record<string, unknown>
                    : {};

                // B3 — preserve `success: false` set by the action's
                // error path (createActionErrorResponse). The previous
                // hard-coded `true` made the workflow treat venue 400s
                // as successful order_acks, fired the "submitted" stream
                // step, and wrote `state="submitted"` into the
                // pending_orders_ledger — locking out user retries via
                // deterministic-idempotency until reconciliation
                // resolved (which it never did, because reconciliation
                // queried the wrong endpoint for margin orders — see B2).
                const inheritedSuccess = metadata.success !== false;
                callbackResult = {
                    ...(content as Content),
                    metadata: {
                        ...metadata,
                        isActionResponse: true,
                        actionName: approved.action,
                        success: inheritedSuccess,
                    },
                } as Content;
                resolve(callbackResult);
                return [];
            };

            const handlerPromise = action.handler(
                state.runtime,
                actionMemory,
                {
                    roomId: state.message.roomId,
                    agentId: state.runtime.agentId,
                    bio: "",
                    lore: "",
                    messageDirections: "",
                    postDirections: "",
                    actors: "",
                    goals: "",
                    recentMessages: "",
                    recentMessagesData: [],
                },
                userParams,
                callback
            );

            handlerPromise
                .then((handlerResult) => {
                    if (!callbackCalled) {
                        const handlerObj = typeof handlerResult === "object" && handlerResult !== null
                            ? handlerResult as Record<string, unknown>
                            : {};
                        const callbackMeta = callbackResult && typeof callbackResult === "object"
                            ? (callbackResult as Content).metadata ?? {}
                            : {};

                        const enhancedResult: Record<string, unknown> = {
                            ...handlerObj,
                            actionData: handlerResult,
                            metadata: {
                                ...(callbackMeta as Record<string, unknown>),
                                ...(handlerObj.metadata && typeof handlerObj.metadata === "object"
                                    ? handlerObj.metadata as Record<string, unknown>
                                    : {}),
                                isActionResponse: true,
                                actionName: approved.action,
                                success: !!handlerResult,
                            },
                        };
                        resolve(enhancedResult);
                    }
                })
                .catch(reject);

            const timeoutMs = typeof state.runtime.getActionTimeout === "function"
                ? state.runtime.getActionTimeout()
                : 300000;
            setTimeout(() => {
                if (!callbackCalled) {
                    reject(new Error(`Action ${approved.action} timed out`));
                }
            }, timeoutMs);
        });

        const result = runInVenueCtx
            ? await runInVenueCtx(venueCtx, invokeAction)
            : await invokeAction();

        // B3 — derive actual action success from the propagated callback
        // metadata. The plugin-cex action handler catches venue 4xx/5xx
        // and surfaces failure via `callback(createActionErrorResponse(...))`
        // (success=false), so the success branch CAN run for failed
        // venue calls. Treating those as "submitted" wrote
        // state="submitted" into the pending-orders ledger and emitted
        // a misleading order_ack — the latter showed up alongside the
        // "insufficient balance" warn line in CloudWatch.
        const resultMetadata: Record<string, unknown> =
            result && typeof result === "object" && result !== null && "metadata" in (result as Record<string, unknown>)
                ? (result as Record<string, unknown>).metadata as Record<string, unknown>
                : {};
        const actionSucceeded = resultMetadata.success !== false;
        const resultErrorMessage = ((): string | undefined => {
            if (!result || typeof result !== "object" || result === null) return undefined;
            const r = result as Record<string, unknown>;
            const errObj = r.error;
            if (errObj && typeof errObj === "object" && "message" in (errObj as Record<string, unknown>)) {
                const m = (errObj as Record<string, unknown>).message;
                if (typeof m === "string") return m;
            }
            if (typeof errObj === "string") return errObj;
            if (typeof r.text === "string") return r.text;
            return undefined;
        })();

        // Track newly submitted order in the pending-orders ledger.
        // B1 — when the action surfaced a soft failure (e.g. venue 400
        // "insufficient balance"), write state="rejected" instead of
        // "submitted". `rejected` is terminal — pre-submit dedup will
        // return `kind:"terminal"` on retry with a clear "previously
        // rejected" message instead of looping the user through
        // "outcome currently uncertain" forever.
        if (approved.action === "create_order") {
            const reconciliationSvc = state.runtime.getService<ITradingReconciliationService>(
                ServiceType.TRADING_RECONCILIATION
            );
            if (reconciliationSvc) {
                const userParamsForTracking = approved.userParams ?? {};
                const clientOrderId = String(userParamsForTracking.client_order_id ?? "");
                const intentHash = String(userParamsForTracking.intent_hash ?? "");
                const requestId = String(userParamsForTracking.request_id ?? "");
                const venue = String(userParamsForTracking.exchange ?? userParamsForTracking.venue ?? "unknown");
                const symbol = String(userParamsForTracking.product_id ?? userParamsForTracking.symbol ?? "unknown");
                const locale = String(state.locale ?? "en");

                if (clientOrderId) {
                    const now = new Date().toISOString();
                    // B2 — carry margin_type into the ledger row so the
                    // reconciliation fallback poller dispatches to
                    // `/sapi/v1/margin/order` instead of the spot endpoint.
                    const marginTypeRaw = userParamsForTracking.margin_type;
                    const marginType: "CROSS" | "ISOLATED" | undefined =
                        marginTypeRaw === "CROSS" || marginTypeRaw === "ISOLATED"
                            ? marginTypeRaw
                            : undefined;
                    await reconciliationSvc.trackOrder({
                        request_id: requestId,
                        intent_hash: intentHash,
                        client_order_id: clientOrderId,
                        venue,
                        symbol,
                        userId: state.message.userId,
                        state: actionSucceeded ? "submitted" : "rejected",
                        submittedAt: now,
                        lastSeenAt: now,
                        latest_payload: actionSucceeded
                            ? result
                            : { error: resultErrorMessage ?? "venue rejected order", source: "venue_rejection" },
                        locale,
                        ...(marginType ? { margin_type: marginType } : {}),
                    }).catch((err: unknown) => {
                        elizaLogger.warn(`[CEXWorkflow] Failed to track order in ledger: ${err instanceof Error ? err.message : String(err)}`);
                    });
                }
            }
        }

        const enhancedActionResult: Record<string, unknown> = {
            action: approved.action,
            userParams: approved.userParams,
            ...(result && typeof result === "object" && result !== null ? result as Record<string, unknown> : {}),
            actionData: (result && typeof result === "object" && result !== null && "actionData" in (result as Record<string, unknown>))
                ? (result as Record<string, unknown>).actionData
                : undefined,
            metadata: {
                ...resultMetadata,
                executionTime: Date.now(),
                iterationNumber: state.iteration,
                // B3 — preserve the soft-failure flag end-to-end so
                // downstream snapshot serializers + UI fallout
                // correctly mark this action as failed.
                success: actionSucceeded,
            },
        };

        const updatedActionResults = [...(state.actionResults || []), enhancedActionResult];

        emitStep(state.streamingCallback, {
            name: "cex_workflow_execute_action",
            status: actionSucceeded ? "completed" : "error",
            message: actionSucceeded
                ? `Action completed: ${approved.action}`
                : `Action failed: ${approved.action}`,
            ...(actionSucceeded ? {} : { error: resultErrorMessage }),
        });

        if (approved.action === "create_order") {
            const ackVenue = String(state.approvedActionCall?.userParams?.exchange ?? state.approvedActionCall?.userParams?.venue ?? "unknown");
            const ackSymbol = String(state.approvedActionCall?.userParams?.product_id ?? state.approvedActionCall?.userParams?.symbol ?? "unknown");
            const ackClientId = String(state.approvedActionCall?.userParams?.client_order_id ?? "");
            if (actionSucceeded) {
                getCEXSpecProvider(state.runtime)?.emitTradingEvent?.({
                    stage: "order_ack",
                    userId: state.message.userId,
                    venue: ackVenue,
                    symbol: ackSymbol,
                    client_order_id: ackClientId || undefined,
                    latency_ms: Date.now() - orderSubmitStart,
                    locale: state.locale,
                });
                // F8 — close the stream step that we opened pre-submit with
                // mode-aware copy. The step `name` matches so the client
                // dispatcher pairs the events.
                const ackCopy = getOrderSubmitCopy({
                    mode: state.resolvedExecutionMode,
                    locale: state.locale,
                    orderSummary: resolveOrderStreamSummary(
                        state.runtime,
                        state.approvedActionCall?.action ?? "",
                        state.approvedActionCall?.userParams as
                            | Record<string, unknown>
                            | undefined,
                    ),
                });
                emitStep(state.streamingCallback, {
                    name: CEX_WORKFLOW_STEPS.orderSubmit,
                    status: "completed",
                    message: ackCopy.completed,
                    data: {
                        type: "trading_order_submit",
                        mode: state.resolvedExecutionMode ?? "live",
                        venue: ackVenue,
                        symbol: ackSymbol,
                        client_order_id: ackClientId || undefined,
                        notional_usd: orderSubmitNotionalUsd(state.approvedActionCall?.userParams as Record<string, unknown> | undefined),
                    },
                });
            } else {
                // B3 — emit `order_error` (not `order_ack`) so SLO
                // dashboards count this as a venue failure rather than
                // a successful place. Mirrors the catch-block emit at
                // the bottom of this function for throws.
                getCEXSpecProvider(state.runtime)?.emitTradingEvent?.({
                    stage: "order_error",
                    userId: state.message.userId,
                    venue: ackVenue,
                    symbol: ackSymbol,
                    client_order_id: ackClientId || undefined,
                    message: resultErrorMessage ?? "venue rejected order",
                    latency_ms: Date.now() - orderSubmitStart,
                    locale: state.locale,
                });
                emitStep(state.streamingCallback, {
                    name: CEX_WORKFLOW_STEPS.orderSubmit,
                    status: "error",
                    message: resultErrorMessage ?? "Order submit failed.",
                    error: resultErrorMessage,
                    data: {
                        type: "trading_order_submit",
                        mode: state.resolvedExecutionMode ?? "live",
                        venue: ackVenue,
                        symbol: ackSymbol,
                        client_order_id: ackClientId || undefined,
                        notional_usd: orderSubmitNotionalUsd(state.approvedActionCall?.userParams as Record<string, unknown> | undefined),
                    },
                });
            }
        }

        return {
            actionResults: updatedActionResults,
            lastExecutedActionResult: enhancedActionResult,
            phase: "action_completed",
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        elizaLogger.error(`[CEXWorkflow] Action failed: ${message}`);
        if (approved.action === "create_order" || approved.action === "cancel_order") {
            const errVenue = String(state.approvedActionCall?.userParams?.exchange ?? "unknown");
            const errSymbol = String(state.approvedActionCall?.userParams?.product_id ?? state.approvedActionCall?.userParams?.symbol ?? "unknown");
            getCEXSpecProvider(state.runtime)?.emitTradingEvent?.({
                stage: "order_error",
                userId: state.message.userId,
                venue: errVenue,
                symbol: errSymbol,
                message,
                locale: state.locale,
                // F4-r3 — submit→error span symmetric with order_ack.
                // Lets the SLO dashboard graph "p99 time-to-error" for
                // venue 5xx / network resets.
                latency_ms: Date.now() - orderSubmitStart,
            });

            // §6.0.3 — if the venue REST call failed AFTER the request was
            // sent (5xx / timeout / network reset), we don't know whether
            // the order landed. Write an `unknown` ledger row so the
            // pre-submit dedup gate refuses retries until the
            // reconciliation poller resolves the state.
            //
            // C4 — broadened from the original "only on network-cause" gate.
            // Any create_order error now writes the UNKNOWN_STATE row +
            // schedules reconciliation, because we cannot tell from a
            // pre-flight throw whether the venue actually received the
            // payload. The deterministic unknown_state user response
            // (`buildUserError({code:"unknown_state"})`) explicitly tells
            // the user we're verifying, with no retry hint.
            const cause = classifyVenueErrorForUnknownState(error) ?? "pre_flight_error";
            if (approved.action === "create_order") {
                const reconciliationSvc = state.runtime.getService<ITradingReconciliationService>(
                    ServiceType.TRADING_RECONCILIATION,
                );
                const userParamsForTracking = approved.userParams ?? {};
                const clientOrderId = String(userParamsForTracking.client_order_id ?? "");
                const intentHash = String(userParamsForTracking.intent_hash ?? "");
                const requestId = String(userParamsForTracking.request_id ?? "");
                const locale = String(state.locale ?? "en");
                if (reconciliationSvc && clientOrderId) {
                    const now = new Date().toISOString();
                    // B1 — only mark UNKNOWN when the failure cause says
                    // the venue MIGHT have received the request (5xx,
                    // timeout, mid-stream socket reset). For a
                    // pre_flight_error / definitive 4xx-style throw the
                    // order definitively did not land, so use `rejected`
                    // (terminal) — pre-submit dedup will return
                    // `kind:"terminal"` on the next retry with a clear
                    // "previously rejected" message instead of looping
                    // the user through "outcome currently uncertain".
                    const ledgerState =
                        cause === "venue_5xx" ||
                        cause === "venue_timeout" ||
                        cause === "venue_network_error"
                            ? "unknown"
                            : "rejected";
                    const marginTypeRaw = userParamsForTracking.margin_type;
                    const marginType: "CROSS" | "ISOLATED" | undefined =
                        marginTypeRaw === "CROSS" || marginTypeRaw === "ISOLATED"
                            ? marginTypeRaw
                            : undefined;
                    await reconciliationSvc
                        .trackOrder({
                            request_id: requestId,
                            intent_hash: intentHash,
                            client_order_id: clientOrderId,
                            venue: errVenue,
                            symbol: errSymbol,
                            userId: state.message.userId,
                            state: ledgerState,
                            submittedAt: now,
                            lastSeenAt: now,
                            latest_payload: { error: message, cause },
                            locale,
                            ...(marginType ? { margin_type: marginType } : {}),
                        })
                        .catch((err: unknown) => {
                            elizaLogger.warn(
                                `[CEXWorkflow] failed to write ${ledgerState}-state ledger row: ${
                                    err instanceof Error ? err.message : String(err)
                                }`,
                            );
                        });
                    if (ledgerState === "unknown") {
                        getCEXSpecProvider(state.runtime)?.emitTradingEvent?.({
                            stage: "unknown_state" as never,
                            userId: state.message.userId,
                            venue: errVenue,
                            symbol: errSymbol,
                            client_order_id: clientOrderId,
                            cause,
                            locale: state.locale,
                        });
                    }
                }
            }
        }

        const errorResult = {
            action: approved.action,
            userParams: approved.userParams,
            text: `Action failed: ${message}`,
            error: message,
            metadata: {
                isActionResponse: true,
                actionName: approved.action,
                success: false,
                executionTime: Date.now(),
                iterationNumber: state.iteration,
            },
        };

        const updatedActionResults = [...(state.actionResults || []), errorResult];

        emitStep(state.streamingCallback, {
            name: "cex_workflow_execute_action",
            status: "error",
            message: `Action failed: ${approved.action}`,
            error: message,
        });

        // C4 — deterministic user response when create_order errors.
        // Bypass the LLM formatter entirely so the response cannot
        // include "or try placing the order again" copy. The
        // unknown_state catalog entry tells the user we're reconciling
        // and warns them NOT to retry until we report back.
        if (approved.action === "create_order") {
            const localeForMsg: Locale = state.locale ?? "en";
            const userError = buildUserError({
                code: "unknown_state",
                locale: localeForMsg,
            });
            const deterministicText = renderUserErrorMarkdown(userError);
            return {
                actionResults: updatedActionResults,
                lastExecutedActionResult: errorResult as Record<string, unknown>,
                llmResponse: deterministicText,
                parsedResponse: { isAction: false, text: deterministicText },
                forceFinalResponse: true,
                shouldContinue: false,
                phase: "action_failed_unknown_state",
            };
        }

        return {
            actionResults: updatedActionResults,
            lastExecutedActionResult: errorResult as Record<string, unknown>,
            phase: "action_failed",
        };
    } finally {
        if (releaseLock) {
            emitStep(state.streamingCallback, {
                name: CEX_WORKFLOW_STEPS.lockRelease,
                status: "completed",
                message: "Released trading lock",
                data: { type: "trading_lock_release" },
            });
            const relVenue = String(state.approvedActionCall?.userParams?.exchange ?? "unknown");
            const relSymbol = String(state.approvedActionCall?.userParams?.product_id ?? state.approvedActionCall?.userParams?.symbol ?? "unknown");
            getCEXSpecProvider(state.runtime)?.emitTradingEvent?.({
                stage: "lock_release",
                userId: state.message.userId,
                venue: relVenue,
                symbol: relSymbol,
                reason: "ack",
            });
            releaseLock();
        }
    }
}

async function generateFormattedResult(state: CEXWorkflowStateType): Promise<Partial<CEXWorkflowStateType>> {
    emitStep(state.streamingCallback, {
        name: "cex_workflow_generate_formatted_result",
        status: "in_progress",
        message: "Formatting trading result...",
    });

    const executed = state.lastExecutedActionResult ?? {};
    const actionName = typeof executed.action === "string" ? executed.action : (state.approvedActionCall?.action ?? "UNKNOWN_ACTION");
    const actionUserParams = executed.userParams && typeof executed.userParams === "object"
        ? JSON.stringify(executed.userParams, null, 2)
        : JSON.stringify(state.approvedActionCall?.userParams ?? {}, null, 2);
    const actionOutput = JSON.stringify(executed, null, 2);
    // F1 — surface the resolved mode to the formatter so the prompt can
    // emit the paper/shadow disclosure badge. Fail-closed to "live" when
    // unset (e.g. for read-only fast-path traffic — no badge needed).
    const executionMode: "live" | "paper" | "shadow" =
        state.resolvedExecutionMode === "paper" || state.resolvedExecutionMode === "shadow"
            ? state.resolvedExecutionMode
            : "live";

    const resultStateData = {
        userMessage: state.message.content.text,
        currentDate: state.currentDate,
        actionName,
        actionParameters: actionUserParams,
        actionOutput,
        executionMode,
        languageInstruction: state.languageInstruction || "",
        roomId: state.message.roomId,
        recentMessagesData: [],
    } as unknown as State;

    const { system, prompt } = composeContextSplit({
        state: resultStateData,
        template: getCEXResultFormattingTemplate(),
    });

    const combinedContext = addHeader(system, prompt).trimEnd();

    try {
        let llmResponse: string;
        let displayText: string;

        try {
            const structured = await generateObject({
                runtime: state.runtime,
                context: combinedContext,
                modelClass: ModelClass.SMALL,
                userId: state.message.userId,
                schema: cexFormattedResultEnvelopeSchema,
                schemaName: "CexTradingFormattedResult",
                schemaDescription: "User-visible markdown trading report in the response field.",
            });
            const envelope = cexFormattedResultEnvelopeSchema.parse(structured.object);
            displayText = envelope.response;
            llmResponse = JSON.stringify(envelope, null, 2);
        } catch (objectError) {
            const omsg = objectError instanceof Error ? objectError.message : String(objectError);
            elizaLogger.info(
                `[CEXWorkflow] generateObject failed for result formatting; using generateText + envelope parse (${omsg})`
            );
            llmResponse = await generateText({
                runtime: state.runtime,
                system,
                prompt,
                modelClass: ModelClass.SMALL,
                userId: state.message.userId,
            });
            displayText = parseCexFormattedResultEnvelope(llmResponse);
        }

        // F1 — mechanical badge prefix. Centralized in `applyMechanicalModeBadge`
        // so the post-check logic is unit-testable in isolation; see
        // `cexResultFormatting.applyMechanicalModeBadge.test.ts`.
        displayText = applyMechanicalModeBadge(displayText, executionMode, state.locale ?? "en");

        emitStep(state.streamingCallback, {
            name: "cex_workflow_generate_formatted_result",
            status: "completed",
            message: "Trading result formatted",
        });

        return {
            llmResponse,
            parsedResponse: { isAction: false, text: displayText },
            forceFinalResponse: true,
            phase: "formatted_result_generated",
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emitStep(state.streamingCallback, {
            name: "cex_workflow_generate_formatted_result",
            status: "error",
            message: "Failed to format trading result",
            error: message,
        });
        return {
            hasError: true,
            errorMessage: `Trading result formatting failed: ${message}`,
            phase: "error",
        };
    }
}

function normalizeResponseNewlines(text: string): string {
    if (typeof text !== "string" || !text.length) return text;
    return text.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t");
}

async function createFinalResponse(state: CEXWorkflowStateType): Promise<Partial<CEXWorkflowStateType>> {
    // Locale-aware fallback. Original code used a Simplified Chinese
    // literal which leaked Chinese into English-locale responses.
    const fallback =
        state.locale === "zh-CN" ? "请告诉我你想查询的交易信息。" : "Tell me what trading info you'd like to look up.";
    const rawFinalText = state.parsedResponse?.text || state.llmResponse?.trim() || fallback;
    let finalText = normalizeResponseNewlines(rawFinalText);

    // §8.1 — when the prompt-injection classifier downgraded the request to
    // read-only, prepend the dedicated notice so the user understands WHY
    // they only see read-only output (instead of the ADK's generic
    // "Trading assistant only runs read-only" message which leaves the
    // signal that we detected suspicious input).
    if (state.promptInjectionDowngrade) {
        const notice = renderPromptInjectionDowngradeNotice(state.locale ?? "en");
        finalText = `${notice}\n\n${finalText}`;
    }

    // §1.7 + §Cross-cutting #2 — Memory carries the detected locale
    // and the venue tag that the next-turn resolver reads as sticky
    // context. Only flag as a "trade" turn if a write action executed,
    // so balance lookups don't pin the sticky exchange beyond their
    // turn.
    const lastAction = state.lastExecutedActionResult;
    const lastActionName =
        lastAction && typeof lastAction === "object" && "action" in lastAction
            ? String((lastAction as Record<string, unknown>).action ?? "")
            : "";
    const writeActionNames = new Set(["create_order", "cancel_order", "amend_order"]);
    const wasTrade = writeActionNames.has(lastActionName);
    const localeForMemory = state.locale ?? "en";
    const lastVenue =
        typeof state.defaultExchangeId === "string" && state.defaultExchangeId.length > 0
            ? state.defaultExchangeId
            : null;

    // F6 — stamp the workflow's stable request_id and a "clarification"
    // flag onto the outbound memory so the runtime precheck-bypass
    // detector can recognize a follow-up turn as a CEX continuation.
    const awaitingClarification = state.phase === "clarification_required";

    // F6-r4 — intent-class breadcrumb. When the workflow is asking for
    // clarification, record which action class the LLM/ADK classified
    // (cancel / create / modify) so the runtime bypass on the NEXT
    // turn can decline if the user's new message implies a different
    // class. Without this, a user follow-up like "buy 0.001 BTC" after
    // a stale "specify order id" cancel clarification would still be
    // routed back through the cancel context.
    const intendedActionFromClarification =
        state.parsedResponse?.actionCall?.action ?? lastActionName;
    const cexIntentClass = intentClassForAction(intendedActionFromClarification);
    const responseMemory: Memory = {
        id: uuidv4() as UUID,
        userId: state.runtime.agentId,
        agentId: state.runtime.agentId,
        roomId: state.message.roomId,
        createdAt: Date.now(),
        content: {
            text: finalText,
            action: null,
            source: "cex_workflow",
            inReplyTo: state.message.id,
            actionResults: state.actionResults || [],
            markdown: true,
            language: localeForMemory,
            metadata: {
                responseFormat: "markdown",
                isMarkdownFormatted: true,
                success: !state.hasError,
                classification: "CEX_WORKFLOW_MESSAGE",
                showModal: true,
                modalType: "cex_workflow_result",
                iterationCount: state.iteration || 0,
                last_used_exchange: lastVenue,
                action_was_trade: wasTrade,
                detected_locale: localeForMemory,
                cexRequestId: state.requestId ?? null,
                cexAwaitingClarification: awaitingClarification,
                cexIntentClass,
            },
        },
    };

    // Lift the agent-emitted `## Key Findings` block onto
    // `content.metadata.summary` so the next turn's recent-messages
    // substitution can drop the full execution narrative.
    const responseMemoryWithSummary = attachResponseSummary(responseMemory, {
        route: "cex",
    });

    await state.runtime.messageManager.createMemory(responseMemoryWithSummary);

    return {
        finalResponse: responseMemoryWithSummary,
        isComplete: true,
        phase: "completed",
    };
}

async function showResultModal(state: CEXWorkflowStateType): Promise<Partial<CEXWorkflowStateType>> {
    const finalText = state.finalResponse?.content?.text;
    emitStep(state.streamingCallback, {
        name: "cex_workflow_show_result_modal",
        status: "completed",
        message: "Trading result ready.",
        data: {
            type: "cex_workflow_result_modal",
            markdown: true,
            content: finalText,
        },
    });

    return {
        phase: "result_modal_shown",
    };
}

async function handleWorkflowError(state: CEXWorkflowStateType): Promise<Partial<CEXWorkflowStateType>> {
    const errorText = state.errorMessage || "Trading workflow encountered an internal error. Please try again.";

    const errorMemory: Memory = {
        id: uuidv4() as UUID,
        userId: state.runtime.agentId,
        agentId: state.runtime.agentId,
        roomId: state.message.roomId,
        createdAt: Date.now(),
        content: {
            text: errorText,
            action: null,
            source: "cex_workflow",
            inReplyTo: state.message.id,
            actionResults: state.actionResults || [],
            markdown: true,
            metadata: {
                responseFormat: "markdown",
                isMarkdownFormatted: true,
                success: false,
                classification: "CEX_WORKFLOW_MESSAGE",
                showModal: true,
                modalType: "cex_workflow_error",
                phase: state.phase,
            },
        },
    };

    await state.runtime.messageManager.createMemory(errorMemory);

    return {
        finalResponse: errorMemory,
        isComplete: true,
        phase: "error_handled",
    };
}

// ----------------------------------------------------------------------
// D — plan-as-text path for multi-step crypto trading requests
// ----------------------------------------------------------------------

/**
 * Stage-1 regex prefilter for multi-step trading intent. Cheap and
 * deterministic; only patterns matching here are passed to the LLM
 * confirm step (saves the round-trip on non-trading turns).
 *
 * NOTE: this is INSIDE the CEX workflow — the upstream classifier has
 * already decided the request is CEX-shaped. We only need to
 * distinguish single-order ("buy 0.01 BTC at market") from multi-step
 * ("DCA $50/week for 8 weeks").
 */
const MULTI_STEP_REGEXES: RegExp[] = [
    /\b(dca|dollar[-\s]cost[-\s]average|dollar[-\s]weighted)\b/i,
    /\bscale[-\s](in|out)\b/i,
    /\bladder\b/i,
    /\bsequence\b/i,
    /\bseries of (buys?|sells?|orders?)\b/i,
    /\bweekly\b.*\b(buy|sell|enter|exit)\b/i,
    /\bover the next\b.*\b(days?|weeks?|months?)\b/i,
    /\bspread (out|across)\b/i,
    /\bscreen.+(top|best|strongest).+(and|then).+(buy|sell|place|trade)\b/i,
    /\brotate\b.+\b(into|to|from)\b.+\b(over|across)\b/i,
    /\btake[-\s]profit\b.*\b(at|level|ladder)\b/i,
    /\bposition exit\b/i,
    // Conditional / scaled buy-ladders, e.g. "buy $300 now, buy another
    // $300 if BTC drops 5%, buy another $200 if it drops 10%, keep $200
    // reserve". These are multi-order plans — route them to the plan
    // executor instead of dead-ending in the keyword-only strategy compiler.
    /\bbuy\s+(another|more)\b/i,
    /\b(buy|sell|add|accumulate|scale)\b[\s\S]{0,80}\bif\b[\s\S]{0,40}\b(drops?|falls?|dips?|declines?|down|below|rises?|gains?|above|hits?|reaches?)\b/i,
    /\bif\b[\s\S]{0,40}\b(drops?|falls?|dips?|declines?|pulls?\s+back|rises?|gains?|jumps?)\b[\s\S]{0,20}\d+(?:\.\d+)?\s*%/i,
    // zh-CN
    /(定投|分批(建仓|减仓|买入|卖出)|轮换)/u,
];

export function matchesMultiStepPattern(text: string): boolean {
    if (!text) return false;
    for (const re of MULTI_STEP_REGEXES) {
        if (re.test(text)) return true;
    }
    return false;
}

/**
 * Resolve the execution mode shown on a plan-as-text card. Honors an
 * explicit per-request override; otherwise defaults to paper in the public
 * demo (PUBLIC_ACCESS_MODE=1, dummy creds — can't move real money) and live
 * elsewhere. Mirrors the paper-default applied to getUserTradingMode /
 * resolveTradingMode so every mode-resolution site agrees.
 */
export function resolvePlanExecutionMode(
    override: "live" | "paper" | "shadow" | null | undefined,
): "live" | "paper" | "shadow" {
    if (override) return override;
    return process.env.PUBLIC_ACCESS_MODE?.trim() === "1" ? "paper" : "live";
}

const PLAN_INTENT_SCHEMA = z.object({
    multiStep: z.boolean(),
    reason: z.string().optional(),
});

/**
 * D1 — detect whether this CEX request is a multi-step trading plan.
 * Two-stage: regex prefilter, then a cheap SLM confirm with strict JSON.
 *
 * On any failure or low-confidence signal we fall through to the normal
 * single-order pipeline (fail-safe — never spurious plan generation).
 */
async function detectPlanIntent(
    state: CEXWorkflowStateType,
): Promise<Partial<CEXWorkflowStateType>> {
    const text = state.message?.content?.text?.trim() ?? "";
    if (!text || !matchesMultiStepPattern(text)) {
        return { isPlanAsText: false };
    }

    elizaLogger.info(
        `[CEXWorkflow] detectPlanIntent regex matched; running LLM confirm`,
    );

    try {
        const response = await generateText({
            runtime: state.runtime,
            system:
                "You are a classifier inside a CEX trading workflow. Decide whether the user's request requires MORE THAN ONE ORDER to fulfil (DCA, ladder, scale-in/out, rotation, screen-and-trade, take-profit ladder, position exit). Single-order requests (\"buy 0.01 BTC at market\") are NOT multi-step. Return strict JSON only.",
            prompt:
                `User request: ${text}\n\nReturn strict JSON: {"multiStep": true|false, "reason": "..."}`,
            modelClass: ModelClass.SMALL,
            userId: state.message.userId,
            temperature: 0,
            maxTokens: 128,
        });

        const trimmed = (response ?? "").trim();
        const startIdx = trimmed.indexOf("{");
        const endIdx = trimmed.lastIndexOf("}");
        if (startIdx === -1 || endIdx <= startIdx) {
            elizaLogger.warn(
                `[CEXWorkflow] detectPlanIntent JSON not found in response; falling through to single-order pipeline`,
            );
            return { isPlanAsText: false };
        }
        const parsed = PLAN_INTENT_SCHEMA.safeParse(JSON.parse(trimmed.slice(startIdx, endIdx + 1)));
        if (!parsed.success) {
            elizaLogger.warn(
                `[CEXWorkflow] detectPlanIntent schema parse failed: ${parsed.error.message}`,
            );
            return { isPlanAsText: false };
        }
        const isPlanAsText = parsed.data.multiStep === true;
        elizaLogger.info(
            `[CEXWorkflow] detectPlanIntent decision: multiStep=${isPlanAsText} reason=${parsed.data.reason ?? ""}`,
        );
        return { isPlanAsText };
    } catch (error) {
        elizaLogger.warn(
            `[CEXWorkflow] detectPlanIntent LLM confirm failed (fail-open to single-order): ${error instanceof Error ? error.message : String(error)}`,
        );
        return { isPlanAsText: false };
    }
}

/**
 * D2/D3/D4 — generate the markdown plan-as-text, stream it back via
 * onToken, persist it as a `cex_workflow` memory tagged with
 * `metadata.cexPlan`, and short-circuit the rest of the workflow.
 *
 * This intentionally does NOT emit a JSON action call. The user must
 * follow up with "place 1" / "place all" to trigger execution; that
 * follow-up re-enters the workflow and falls back to the existing
 * single-order pipeline.
 */
async function generatePlanAsText(
    state: CEXWorkflowStateType,
): Promise<Partial<CEXWorkflowStateType>> {
    emitStep(state.streamingCallback, {
        name: "cex_workflow_plan_as_text",
        status: "in_progress",
        message: "Drafting multi-step trading plan...",
    });

    // Best-effort mode resolution. The risk engine resolves the
    // canonical execution mode later, but at planner time we use the
    // user's prefix override first, then "live" as the fail-safe
    // default. We surface this verbatim in the plan output so the user
    // can see and correct it before placing any step.
    const executionMode: "live" | "paper" | "shadow" =
        resolvePlanExecutionMode(state.executionModeOverride);

    const template = getCexPlanAsTextTemplate();

    const stateData = {
        userMessage: state.message.content.text,
        currentDate: state.currentDate,
        recentMessages: state.recentMessages,
        pendingTradingPlans: state.pendingTradingPlans || "",
        userTraits: state.userTraits,
        executionMode,
        roomId: state.message.roomId,
        recentMessagesData: [],
    } as unknown as State;

    const { system, prompt } = composeContextSplit({
        state: stateData,
        template,
    });

    let planText = "";
    try {
        planText = await generateText({
            runtime: state.runtime,
            system,
            prompt,
            modelClass: ModelClass.MEDIUM,
            userId: state.message.userId,
            // 0.1 keeps the structure stable while leaving the model
            // room to vary phrasing — pure 0 produced repetitive
            // language during local smoke tests.
            temperature: 0.1,
            maxTokens: 1024,
            // B3 — paid-tier CEX workflow is already gated upstream; the
            // resolveModelClass downgrade for free-tier users would
            // otherwise silently demote this to SMALL and produce a
            // sloppier plan. Matches the main-loop generator's bypass.
            bypassModelClassDowngrades: true,
            onToken: state.onToken,
        });
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        elizaLogger.error(
            `[CEXWorkflow] generatePlanAsText generateText failed: ${errMsg}`,
        );
        return {
            hasError: true,
            errorMessage: `Plan generation failed: ${errMsg}`,
            phase: "error",
        };
    }

    const finalText = planText && planText.trim().length > 0
        ? planText.trim()
        : state.locale === "zh-CN"
            ? "无法生成多步交易计划，请尝试用更具体的描述（例如「每周 50 美元 BTC，共 8 周」）。"
            : "Could not draft a multi-step plan. Try restating the request with more specifics (e.g. \"$50 BTC weekly for 8 weeks\").";

    // Step count for the metadata breadcrumb. A simple heuristic — line
    // starts with `<number>.` — is sufficient and doesn't require a JSON
    // round-trip from the model.
    const stepCount = (finalText.match(/^\s*\d+\.\s+/gm) ?? []).length;

    const localeForMemory = state.locale ?? "en";
    const responseMemory: Memory = {
        id: uuidv4() as UUID,
        userId: state.runtime.agentId,
        agentId: state.runtime.agentId,
        roomId: state.message.roomId,
        createdAt: Date.now(),
        content: {
            text: finalText,
            action: null,
            source: "cex_workflow",
            inReplyTo: state.message.id,
            actionResults: [],
            markdown: true,
            language: localeForMemory,
            metadata: {
                responseFormat: "markdown",
                isMarkdownFormatted: true,
                success: true,
                classification: "CEX_WORKFLOW_MESSAGE",
                showModal: true,
                modalType: "cex_workflow_result",
                iterationCount: 0,
                detected_locale: localeForMemory,
                cexRequestId: state.requestId ?? null,
                // D4 — tag the turn so CloudWatch greps and the future
                // grouped-approval planner can locate plan turns.
                cexPlan: {
                    kind: "plan_as_text",
                    steps: stepCount,
                    mode: executionMode,
                },
            },
        },
    };

    // Use the plan body's `## Key Findings` block as the
    // recent-context summary. The plan template requires the model to
    // emit a single-bullet block recording the plan shape, which is the
    // most useful follow-up-turn breadcrumb. Fallback override keeps the
    // mechanism honest even if the model omits the section.
    const planSummaryOverride = `- Plan emitted: ${stepCount} step${stepCount === 1 ? "" : "s"}, mode = ${executionMode}.`;
    const responseMemoryWithSummary = attachResponseSummary(responseMemory, {
        route: "cex_plan",
        summaryOverride: planSummaryOverride,
    });

    await state.runtime.messageManager.createMemory(responseMemoryWithSummary);

    emitStep(state.streamingCallback, {
        name: "cex_workflow_plan_as_text",
        status: "completed",
        message: `Plan emitted (${stepCount} step${stepCount === 1 ? "" : "s"})`,
        data: { steps: stepCount, mode: executionMode },
    });

    return {
        finalResponse: responseMemoryWithSummary,
        isComplete: true,
        planAsTextStepCount: stepCount,
        phase: "plan_as_text_completed",
    };
}

function createCEXWorkflow() {
    // §4 Observability: wrap each node in traceCexNode so it becomes a `node:<name>` child
    // span of the per-turn handler root span, with the node's terminal phase mapped onto
    // `decision.outcome` (transparent when OTEL_TRACING_ENABLED is unset).
    const workflow = new StateGraph(CEXWorkflowState)
        .addNode("initialize", traceCexNode("initialize", initializeWorkflow))
        .addNode("detectPlanIntent", traceCexNode("detectPlanIntent", detectPlanIntent))
        .addNode("generatePlanAsText", traceCexNode("generatePlanAsText", generatePlanAsText))
        .addNode("generateResponse", traceCexNode("generateResponse", generateLLMResponse))
        .addNode("parseResponse", traceCexNode("parseResponse", parseResponse))
        .addNode("executeReadOnlyAction", traceCexNode("executeReadOnlyAction", prepareReadOnlyAction))
        .addNode("requestParameterReview", traceCexNode("requestParameterReview", requestParameterReview))
        .addNode("requestParameterFinalConfirm", traceCexNode("requestParameterFinalConfirm", requestParameterFinalConfirm))
        .addNode("executeAction", traceCexNode("executeAction", executeAction))
        .addNode("generateFormattedResult", traceCexNode("generateFormattedResult", generateFormattedResult))
        .addNode("createFinalResponse", traceCexNode("createFinalResponse", createFinalResponse))
        .addNode("showResultModal", traceCexNode("showResultModal", showResultModal))
        .addNode("handleError", traceCexNode("handleError", handleWorkflowError))

        .addEdge("__start__", "initialize")
        .addConditionalEdges("initialize", (state: CEXWorkflowStateType) => {
            if (state.hasError) return "handleError";
            // §1.1 clarification short-circuit. Skip LLM + approval and
            // emit the localized clarification as the final response.
            if (state.phase === "clarification_required") return "createFinalResponse";
            // D — multi-step crypto-trading plan detection runs before
            // the action-extraction loop so we never accidentally fire
            // a single order when the user wants a DCA/ladder/rotation.
            return "detectPlanIntent";
        })
        .addConditionalEdges("detectPlanIntent", (state: CEXWorkflowStateType) => {
            if (state.hasError) return "handleError";
            if (state.isPlanAsText) return "generatePlanAsText";
            return "generateResponse";
        })
        .addConditionalEdges("generatePlanAsText", (state: CEXWorkflowStateType) => {
            if (state.hasError) return "handleError";
            // Skip `createFinalResponse` — the planner already built and
            // persisted the response memory with `metadata.cexPlan`.
            return "showResultModal";
        })
        .addConditionalEdges("generateResponse", (state: CEXWorkflowStateType) => (state.hasError ? "handleError" : "parseResponse"))

        .addConditionalEdges("parseResponse", (state: CEXWorkflowStateType) => {
            if (state.hasError) return "handleError";
            if (state.parsedResponse?.isAction && state.iteration < state.maxIterations) {
                // §1.2 stake-aware fast path. Read-only actions bypass
                // the two-step approval flow.
                const action = state.parsedResponse.actionCall?.action;
                if (action && isReadOnlyStake(classifyStake(action))) {
                    return "executeReadOnlyAction";
                }
                return "requestParameterReview";
            }
            return "createFinalResponse";
        })

        .addConditionalEdges("executeReadOnlyAction", (state: CEXWorkflowStateType) => {
            if (state.hasError) return "handleError";
            return "executeAction";
        })
        // Single-confirm flow: requestParameterReview is the only human
        // gate. The second backend approval (requestParameterFinalConfirm)
        // remains in the graph as a no-op fallback for callers that have
        // not yet migrated, but the default path skips it.
        .addConditionalEdges("requestParameterReview", (state: CEXWorkflowStateType) => {
            if (state.hasError) return "handleError";
            if (state.forceFinalResponse) return "createFinalResponse";
            return "executeAction";
        })
        .addConditionalEdges("requestParameterFinalConfirm", (state: CEXWorkflowStateType) => {
            if (state.hasError) return "handleError";
            if (state.forceFinalResponse) return "createFinalResponse";
            return "executeAction";
        })

        .addConditionalEdges("executeAction", (state: CEXWorkflowStateType) => (state.hasError ? "handleError" : "generateFormattedResult"))
        .addConditionalEdges("generateFormattedResult", (state: CEXWorkflowStateType) => (state.hasError ? "handleError" : "createFinalResponse"))

        .addConditionalEdges("createFinalResponse", (state: CEXWorkflowStateType) => (state.hasError ? "handleError" : "showResultModal"))

        .addEdge("showResultModal", "__end__")
        .addEdge("handleError", "__end__");

    return workflow.compile();
}

export class CEXWorkflowService {
    private runtime: IAgentRuntime;
    private workflow: ReturnType<typeof createCEXWorkflow>;

    constructor(runtime: IAgentRuntime) {
        this.runtime = runtime;
        this.workflow = createCEXWorkflow();
        elizaLogger.info("[CEXWorkflow] Service initialized");
    }

    async handleMessage(
        message: Memory,
        callback?: HandlerCallback,
        streamingCallback?: StreamingCallback,
        intermediateResponseCallback?: (response: Memory) => void,
        onToken?: (delta: string) => Promise<void> | void
    ): Promise<Memory[]> {
        const langSmithMetadataEntries = Object.entries({
            runType: "cex_workflow",
            agentId: this.runtime.agentId,
            character: this.runtime.character?.name,
            messageId: message.id,
            roomId: message.roomId,
        }).filter(([, value]) => value !== undefined && value !== null && value !== "");

        const langSmithMetadata = Object.fromEntries(langSmithMetadataEntries) as Record<string, unknown>;

        const langSmithConfig = buildLangSmithRunnableConfig({
            apiKey: this.runtime.getSetting("LANGCHAIN_API_KEY")
                ?? this.runtime.getSetting("LANGSMITH_API_KEY")
                ?? undefined,
            endpoint: this.runtime.getSetting("LANGCHAIN_ENDPOINT")
                ?? this.runtime.getSetting("LANGSMITH_ENDPOINT")
                ?? undefined,
            projectName: this.runtime.getSetting("LANGSMITH_PROJECT")
                ?? this.runtime.getSetting("LANGCHAIN_PROJECT")
                ?? this.runtime.character?.name
                ?? undefined,
            runName: message.id
                ? `cex-workflow:${message.id}`
                : "cex-workflow",
            tags: [
                "cex-workflow",
                this.runtime.character?.name ? `agent:${this.runtime.character.name}` : undefined,
            ].filter((tag): tag is string => typeof tag === "string" && tag.length > 0),
            metadata: langSmithMetadata,
        });

        const initialState = {
            message,
            runtime: this.runtime,
            callback,
            streamingCallback,
            intermediateResponseCallback,
            onToken,
        } as unknown as CEXWorkflowStateType;

        const result = langSmithConfig
            ? await this.workflow.invoke(initialState, langSmithConfig)
            : await this.workflow.invoke(initialState);

        if (result.finalResponse) {
            if (intermediateResponseCallback) {
                intermediateResponseCallback(result.finalResponse);
            }

            if (callback) {
                await callback({
                    text: result.finalResponse.content.text,
                    action: result.finalResponse.content.action,
                    source: result.finalResponse.content.source,
                    actionResults: result.finalResponse.content.actionResults || [],
                    markdown: result.finalResponse.content.markdown,
                    metadata: result.finalResponse.content.metadata,
                });
            }

            return [result.finalResponse];
        }

        return [];
    }
}

const workflowServicesByAgent = new Map<string, CEXWorkflowService>();

/**
 * 2026-05-25 hardening (QA H-2 / M-1 / M-2 / H-4) — deterministic
 * red-team short-circuit at the TOP of the CEX entry. The legacy
 * workflow has the same check inside its preprocess graph, but the
 * plan runner (`runPlanModeIfApplicable`) intercepts first, generates a
 * clarification plan ("Could you please specify the asset..."), and
 * returns it as a Memory — the legacy gate is then never reached.
 * Placing this check at the workflow entry guarantees the refusal
 * fires regardless of which downstream path the message would have
 * taken. Pattern is identical to the `trading_safety_override` pattern
 * in `promptInjectionDefense.ts` and to `RED_TEAM_TRADING_SAFETY` in
 * the legacy graph.
 */
const RED_TEAM_TRADING_SAFETY_ENTRY =
    /\b(bypass|skip|disable|ignore|override|disregard|turn\s*off)\b[^.\n]{0,40}\b(confirm(?:ation)?s?|risk(?:\s*(?:engine|management|gate|check))?|safety|guard(?:rail)?s?|approvals?|limits?|caps?|gates?|protections?|policy|policies|rules?)\b/i;

async function buildRedTeamRefusalMemory(
    runtime: IAgentRuntime,
    message: Memory,
    callback?: HandlerCallback,
): Promise<Memory[]> {
    const messageText = message.content?.text?.trim() ?? "";
    // Heuristic Chinese detection — matches the same pattern used by
    // language detection elsewhere in the workflow.
    const isZh = /[一-鿿]/.test(messageText);
    const refusal = isZh
        ? "我无法跳过或关闭交易安全机制——每笔订单都需要通过确认与风险引擎检查。如需调整某项上限,请在 设置 → 风险限额 中修改。"
        : "I can't bypass or disable the trading safety gates — confirmation and the risk engine apply to every order. If you want to adjust a specific cap, open Settings → Risk Limits.";
    elizaLogger.info(
        `[CEXWorkflow] red-team-entry refusal fired for messageText="${messageText.slice(0, 80)}"`,
    );
    const reply: Memory = {
        id: stringToUuid(`red-team-refusal-${message.id}-${Date.now()}`) as UUID,
        userId: message.userId,
        agentId: message.agentId,
        roomId: message.roomId,
        content: {
            text: refusal,
            action: "prompt_injection_refused",
            source: "cex_workflow",
            inReplyTo: message.id,
        },
        createdAt: Date.now(),
    };
    try {
        await runtime.messageManager.createMemory(reply);
    } catch (err) {
        elizaLogger.warn(`[CEXWorkflow] red-team-entry persist failed: ${err}`);
    }
    if (callback) {
        try {
            await callback({
                text: refusal,
                action: "prompt_injection_refused",
                source: "cex_workflow",
            });
        } catch (err) {
            elizaLogger.warn(`[CEXWorkflow] red-team-entry callback failed: ${err}`);
        }
    }
    return [reply];
}

export async function handleCEXWorkflowMessage(
    runtime: IAgentRuntime,
    message: Memory,
    callback?: HandlerCallback,
    streamingCallback?: StreamingCallback,
    intermediateResponseCallback?: (response: Memory) => void,
    onToken?: (delta: string) => Promise<void> | void
): Promise<Memory[]> {
    // 2026-05-25 hardening — red-team short-circuit BEFORE any plan
    // runner / preprocess so the refusal fires regardless of which
    // downstream path would have handled the message.
    const entryText = message.content?.text?.trim() ?? "";
    if (RED_TEAM_TRADING_SAFETY_ENTRY.test(entryText)) {
        return await buildRedTeamRefusalMemory(runtime, message, callback);
    }

    // Pre-empt: the plan runner short-circuits the legacy workflow when:
    //   1. `CEX_PLAN_EXECUTION_ENABLED=true` setting is active, AND
    //   2. either there's an active multi-step plan in this room
    //      (continuation: user replies "yes" / "yes, all" / "cancel"
    //      to a prior plan card), OR the decomposer produces a
    //      multi-step plan from the current message.
    // Returning `null` falls through to the legacy single-action
    // workflow (1-step plans, decomposer failure, continuation parser
    // returns UNKNOWN — i.e. the user has changed topic).
    try {
        const planResult = await runPlanModeIfApplicable({
            runtime,
            message,
            callback,
            streamingCallback,
            intermediateResponseCallback,
            onToken,
        });
        if (planResult !== null) {
            return planResult;
        }
    } catch (error) {
        // Plan-mode failures must NEVER block the legacy path. We
        // log loudly and fall through.
        elizaLogger.error(
            `[CEXWorkflow] plan runner threw (falling through to legacy): ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    let workflowService = workflowServicesByAgent.get(runtime.agentId);
    if (!workflowService) {
        workflowService = new CEXWorkflowService(runtime);
        workflowServicesByAgent.set(runtime.agentId, workflowService);
    }

    return workflowService.handleMessage(message, callback, streamingCallback, intermediateResponseCallback, onToken);
}
