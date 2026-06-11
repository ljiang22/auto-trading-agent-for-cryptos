import type { UserTradingPreferences } from "../risk/types";

export interface RoutedMemorySnippet {
    /** Stable id for the inserted memory chunk (e.g., row id or hash). */
    id: string;
    /** Source: "preferences" | "recent_trade" | "watchlist" | "thread". */
    source: "preferences" | "recent_trade" | "watchlist" | "thread";
    /** One-line localized phrasing for prompt injection. */
    line: string;
}

export interface MemoryRouterInput {
    /** The user's text message (current turn). */
    messageText: string;
    /** Locale of the response (en | zh-CN). */
    locale: "en" | "zh-CN";
    /** User trading preferences (Phase 1 collection). */
    preferences?: UserTradingPreferences;
    /**
     * Recent pending-order ledger rows for the user (most recent first).
     * The router uses these for episodic recall ("last BTC trade").
     */
    recentTrades?: Array<{
        client_order_id: string;
        venue: string;
        symbol?: string;
        side?: "BUY" | "SELL";
        state: string;
        submittedAt?: string;
    }>;
    /** Memory rows from the thread (most recent first). */
    threadMemories?: Array<{ id: string; content: string }>;
}

export interface MemoryRouterOutput {
    snippets: RoutedMemorySnippet[];
    /** Compact summary suitable for direct prompt injection. */
    summary: string;
}

function referencesPreferences(text: string): boolean {
    return (
        /\b(my (preferences|defaults|settings|risk|limit)|kill switch|set my)\b/i.test(text) ||
        /我的(偏好|设置|风险|限额|默认|紧急开关)/.test(text)
    );
}

function referencesHistory(text: string): boolean {
    return (
        /\b(last|previous|recent|history)\b.*\b(trade|order|buy|sell|trades|orders)\b/i.test(
            text,
        ) ||
        /\b(my last)\b/i.test(text) ||
        /(上次|最近|历史)(交易|订单|买|卖)/u.test(text)
    );
}

function formatPreferencesLine(
    prefs: UserTradingPreferences,
    locale: "en" | "zh-CN",
): string {
    if (locale === "zh-CN") {
        return `用户偏好：风险偏好=${prefs.risk_profile}，最大订单名义=$${prefs.max_order_notional_usd}，日亏损限额=$${prefs.daily_loss_limit_usd}${
            prefs.kill_switch_active ? "（紧急开关已激活）" : ""
        }`;
    }
    return `User preferences: risk_profile=${prefs.risk_profile}, max_order_notional_usd=$${prefs.max_order_notional_usd}, daily_loss_limit_usd=$${prefs.daily_loss_limit_usd}${
        prefs.kill_switch_active ? " (kill switch active)" : ""
    }`;
}

function formatTradeLine(
    trade: NonNullable<MemoryRouterInput["recentTrades"]>[number],
    locale: "en" | "zh-CN",
): string {
    if (locale === "zh-CN") {
        return `最近订单：${trade.side ?? "?"} ${trade.symbol ?? "?"} 在 ${trade.venue}，状态=${trade.state}`;
    }
    return `Recent order: ${trade.side ?? "?"} ${trade.symbol ?? "?"} on ${trade.venue}, state=${trade.state}`;
}

/**
 * Decides which memories to inject into the trading prompt this turn.
 * Preferences are included whenever the message references them OR risk
 * limits matter (write intents). Recent trades are included on history-
 * shaped queries.
 */
export function routeMemory(input: MemoryRouterInput): MemoryRouterOutput {
    const snippets: RoutedMemorySnippet[] = [];

    if (input.preferences && referencesPreferences(input.messageText)) {
        snippets.push({
            id: `prefs:${input.preferences.userId}`,
            source: "preferences",
            line: formatPreferencesLine(input.preferences, input.locale),
        });
    }

    if (referencesHistory(input.messageText) && input.recentTrades) {
        for (const t of input.recentTrades.slice(0, 3)) {
            snippets.push({
                id: `trade:${t.client_order_id}`,
                source: "recent_trade",
                line: formatTradeLine(t, input.locale),
            });
        }
    }

    const summary = snippets.map((s) => s.line).join("\n");
    return { snippets, summary };
}
