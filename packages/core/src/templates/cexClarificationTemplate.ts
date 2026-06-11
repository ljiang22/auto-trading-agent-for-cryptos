import type { Locale } from "../utils/languageUtils";

const VENUE_DISPLAY: Record<string, { en: string; "zh-CN": string }> = {
    binance: { en: "Binance", "zh-CN": "币安 (Binance)" },
    coinbase: { en: "Coinbase", "zh-CN": "Coinbase" },
};

function venueLabel(venue: string, locale: Locale): string {
    const entry = VENUE_DISPLAY[venue];
    if (!entry) return venue;
    return locale === "zh-CN" ? entry["zh-CN"] : entry.en;
}

/**
 * Renders the clarification question for the "user has 2+ exchanges,
 * write intent, no signal" path. Mirrors the resolver outcome's
 * locale.
 */
export function renderExchangeClarification(
    options: string[],
    locale: Locale,
): string {
    if (options.length === 0) {
        return locale === "zh-CN"
            ? "您还没有配置任何交易所。请在设置中先添加 Binance 或 Coinbase 的 API 凭据。"
            : "You haven't configured any exchanges yet. Please add Binance or Coinbase API credentials in Settings first.";
    }
    const labels = options.map((v) => venueLabel(v, locale));
    if (locale === "zh-CN") {
        const list =
            labels.length === 2
                ? `${labels[0]} 和 ${labels[1]}`
                : labels.join("、");
        return `您配置了 ${list}。这次交易要使用哪一家?`;
    }
    const list =
        labels.length === 2
            ? `${labels[0]} and ${labels[1]}`
            : labels.length === 1
                ? labels[0]
                : `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
    return `You have ${list} configured. Which one should I use for this trade?`;
}

/**
 * Localized message for the risk-blocked / safe-downgraded path.
 */
export function renderRiskBlockedMessage(
    reasons: string[],
    locale: Locale,
): string {
    const joined = reasons.length > 0 ? reasons.join("; ") : "Risk gate blocked the order";
    if (locale === "zh-CN") {
        return `无法继续这笔交易: ${joined}。可以查询余额或最近的订单。`;
    }
    return `I can't proceed with this order: ${joined}. Read-only queries (balance, recent orders) still work.`;
}

export function renderKillSwitchActiveMessage(locale: Locale): string {
    if (locale === "zh-CN") {
        return "交易当前已被禁用 — 紧急停止开关已激活。可以在设置中关闭该开关后再试。";
    }
    return "Trading is currently disabled — kill switch active. You can disable it in Settings to resume.";
}

export function renderExchangeNotConfiguredMessage(venue: string, locale: Locale): string {
    const label = venueLabel(venue, locale);
    if (locale === "zh-CN") {
        return `您尚未在 ${label} 上配置 API 密钥。请前往设置添加您的 ${label} API 凭据后再试。`;
    }
    return `You haven't configured API keys for ${label} yet. Please go to Settings to add your ${label} credentials first.`;
}
