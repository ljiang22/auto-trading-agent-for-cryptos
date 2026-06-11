/**
 * Pre-LLM deterministic preprocessing for the CEX workflow.
 *
 * Resolves locale + stake hint + exchange in a single pass, before
 * any LLM call. Output is fed into the LangGraph state for downstream
 * nodes. See plan §1.1 + §Cross-cutting #1/#2.
 *
 * The function is pure (no I/O, no `Date.now()`). The handler is
 * responsible for passing in `recentMemories` and account context.
 */

import type { Memory } from "../core/types";
import {
    type ExchangeResolution,
    type ExchangeResolverInput,
    resolveExchange,
    type Stake,
} from "./exchangeResolver";
import { detectLocale, type Locale } from "../utils/languageUtils";

export type PreprocessStakeHint = Stake | "unknown";

export interface CexPreprocessInput<TVenue extends string = string> {
    messageText: string;
    recentMemories: Memory[];
    /** Venues the user has configured. First entry should be the default if any. */
    configuredVenues: TVenue[];
    defaultVenue?: TVenue;
    preferredVenue?: TVenue | null;
    preferredLanguage?: "en" | "zh-CN" | null;
    /**
     * Optional pre-classification from an upstream allowlist heuristic
     * (e.g., "show", "buy", "sell" keywords). If absent or "unknown",
     * the resolver assumes `"write"` to fail closed: a write intent
     * with multiple configured venues will trigger clarification,
     * which is the safe outcome.
     */
    stakeHint?: PreprocessStakeHint;
    matchToken: (token: string) => TVenue | null;
    findMentionInText: (text: string) => TVenue | null;
}

export interface CexPreprocessOutput<TVenue extends string = string> {
    locale: Locale;
    stake: Stake;
    exchange_resolution: ExchangeResolution<TVenue>;
    /**
     * C3 — per-message execution-mode prefix override. Parsed from
     * "paper mode:", "live mode:", "shadow mode:" (EN + zh-CN
     * equivalents) at the start of the user's message, AHEAD of any
     * LLM extraction. Downstream risk-precheck consumes this with
     * higher precedence than `params.mode` so a user explicitly typing
     * "paper mode: …" cannot have it silently dropped by the LLM.
     */
    mode_override: "live" | "paper" | "shadow" | null;
}

const MODE_PREFIX_RE =
    /^[\s>"'“”\[\(]*(paper|live|shadow)\s*mode\s*[:：]/i;
const MODE_PREFIX_RE_ZH = /^[\s>"'“”\[\(]*(纸面|实盘|影子)\s*模式\s*[:：]/u;

/** Map zh-CN mode words to canonical English. */
const ZH_TO_EN_MODE: Record<string, "paper" | "live" | "shadow"> = {
    "纸面": "paper",
    "实盘": "live",
    "影子": "shadow",
};

/**
 * C3 — return the explicit mode the user requested at the *start* of
 * the message, or null. Anchored to the start to avoid false positives
 * deep inside the text ("…compared with paper mode:" wouldn't match).
 * Deterministic, no LLM needed.
 */
export function parseExecutionModePrefix(text: string): "live" | "paper" | "shadow" | null {
    if (!text) return null;
    const en = MODE_PREFIX_RE.exec(text);
    if (en) return en[1].toLowerCase() as "live" | "paper" | "shadow";
    const zh = MODE_PREFIX_RE_ZH.exec(text);
    if (zh) {
        const mapped = ZH_TO_EN_MODE[zh[1]];
        if (mapped) return mapped;
    }
    return null;
}

export function preprocess<TVenue extends string>(
    input: CexPreprocessInput<TVenue>,
): CexPreprocessOutput<TVenue> {
    const localeFallback: Locale =
        input.preferredLanguage === "zh-CN" || input.preferredLanguage === "en"
            ? input.preferredLanguage
            : "en";
    const locale = detectLocale(input.messageText, localeFallback);

    const stake: Stake =
        input.stakeHint === "read_only" || input.stakeHint === "write"
            ? input.stakeHint
            : "write";

    const resolverInput: ExchangeResolverInput<TVenue> = {
        messageText: input.messageText,
        recentMemories: input.recentMemories,
        configuredVenues: input.configuredVenues,
        defaultVenue: input.defaultVenue,
        preferredVenue: input.preferredVenue ?? null,
        stake,
        matchToken: input.matchToken,
        findMentionInText: input.findMentionInText,
    };
    const exchange_resolution = resolveExchange(resolverInput);
    const mode_override = parseExecutionModePrefix(input.messageText);

    return { locale, stake, exchange_resolution, mode_override };
}

/**
 * Cheap heuristic for the preprocess `stakeHint`. Used by callers
 * that have the raw message but not yet the parsed action. Keyword
 * lists are intentionally conservative — anything ambiguous returns
 * `"unknown"` so the resolver fails closed.
 */
const READ_KEYWORDS_EN = [
    "balance", "balances", "holdings", "portfolio",
    "show", "list", "view", "check", "what is", "what's", "how much",
    "history", "fills", "orders", "open orders", "recent orders",
    "status",
];
const READ_KEYWORDS_ZH = ["余额", "持仓", "查询", "查看", "显示", "列表", "成交"];
const WRITE_KEYWORDS_EN = [
    "buy", "sell", "purchase", "place order", "submit order", "create order",
    "cancel", "amend", "modify order", "close position", "market order", "limit order",
];
const WRITE_KEYWORDS_ZH = ["买", "卖", "下单", "撤单", "市价单", "限价单", "取消"];

export function inferStakeHint(text: string): PreprocessStakeHint {
    if (!text) return "unknown";
    const lower = text.toLowerCase();
    const hasWrite =
        WRITE_KEYWORDS_EN.some((kw) => lower.includes(kw)) ||
        WRITE_KEYWORDS_ZH.some((kw) => text.includes(kw));
    if (hasWrite) return "write";
    const hasRead =
        READ_KEYWORDS_EN.some((kw) => lower.includes(kw)) ||
        READ_KEYWORDS_ZH.some((kw) => text.includes(kw));
    if (hasRead) return "read_only";
    return "unknown";
}
