/**
 * §8.12 — operator-controlled global kill switch for live trading.
 *
 * Set `LIVE_TRADING_GLOBAL_KILL=1` (or `true` / `yes` / `on`) in the
 * environment to refuse every live-mode write across every user. Paper +
 * shadow modes are unaffected so dev and CI can keep running.
 *
 * Read at request time (NOT cached at module load) so an SSM parameter
 * push + ECS task env reload flips the flag without a fresh deploy.
 */

export const LIVE_TRADING_GLOBAL_KILL_REASON = "live_trading_global_kill_active";

const TRUTHY = new Set(["1", "true", "yes", "on", "enabled"]);

export function isLiveTradingGlobalKillActive(): boolean {
    const raw = process.env.LIVE_TRADING_GLOBAL_KILL;
    if (raw === undefined) return false;
    return TRUTHY.has(raw.trim().toLowerCase());
}

export function renderLiveTradingGlobalKillMessage(
    locale: "en" | "zh-CN" | "mixed-en",
): string {
    if (locale === "zh-CN") {
        return [
            "🛑 全局实时交易已暂停 — 运维已激活紧急停机开关。",
            "查询和模拟交易仍可使用。",
        ].join("\n");
    }
    return [
        "🛑 Global live trading is paused — operator has activated the emergency stop.",
        "Read-only queries and paper-mode trading remain available.",
    ].join("\n");
}
