import type { CanonicalIntent } from "../../intent/canonicalIntent";
import { BACKSTOP_DENIED_ASSETS } from "../types";
import type { RiskEvaluationContext, RiskRuleResult } from "../types";

/**
 * Allow + block list rule. Symbol form `BASE-QUOTE` (e.g., "BTC-USD")
 * is normalized to the base for the allow / block lookup.
 *
 * Order of precedence:
 *   1. Hard-coded platform backstop (BACKSTOP_DENIED_ASSETS) — fires
 *      regardless of user prefs. Curated for known-risky / delisted
 *      assets (LUNA, FTT, et al.). QA H-3 root-fix.
 *   2. User asset_blocklist.
 *   3. User asset_allowlist (only when non-empty).
 */
export function assetAllowlist(
    intent: CanonicalIntent,
    ctx: RiskEvaluationContext,
): RiskRuleResult {
    if (intent.action === "get_balance") {
        return { id: "assetAllowlist", verdict: "allow" };
    }
    if (!intent.symbol) {
        return { id: "assetAllowlist", verdict: "allow" };
    }
    const base = extractBaseAsset(intent.symbol);
    const baseUpper = base.toUpperCase();
    if (BACKSTOP_DENIED_ASSETS.has(baseUpper)) {
        return {
            id: "assetAllowlist",
            verdict: "block",
            explanation: `Asset ${baseUpper} is on the platform's restricted-assets list and cannot be traded.`,
            metadata: { base: baseUpper, reason: "platform_backstop" },
        };
    }
    const blocklist = ctx.preferences.asset_blocklist.map((s) => s.toUpperCase());
    const allowlist = ctx.preferences.asset_allowlist.map((s) => s.toUpperCase());
    if (blocklist.includes(baseUpper)) {
        return {
            id: "assetAllowlist",
            verdict: "block",
            explanation: `Asset ${baseUpper} is on your blocklist`,
            metadata: { base: baseUpper, blocklist },
        };
    }
    if (allowlist.length > 0 && !allowlist.includes(baseUpper)) {
        return {
            id: "assetAllowlist",
            verdict: "block",
            explanation: `Asset ${baseUpper} is not on your allowlist`,
            metadata: { base: baseUpper, allowlist },
        };
    }
    return { id: "assetAllowlist", verdict: "allow" };
}

function extractBaseAsset(symbol: string): string {
    const dashIdx = symbol.indexOf("-");
    if (dashIdx > 0) return symbol.slice(0, dashIdx);
    // Binance-style "BTCUSDT" — fall back to first 3 chars; not perfect
    // but only matters as a soft signal here since the canonical
    // product_id form is BASE-QUOTE everywhere we control.
    return symbol.length > 3 ? symbol.slice(0, 3) : symbol;
}
