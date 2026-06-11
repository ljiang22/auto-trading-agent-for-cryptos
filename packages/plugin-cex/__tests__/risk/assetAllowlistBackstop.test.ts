/**
 * 2026-05-25 hardening (QA H-3) — backstop deny-list inside the
 * assetAllowlist risk rule.
 *
 * The QA flagged that LUNA/USDT built a full order preview because
 * the user allowlist defaulted to empty. The fix adds a hard-coded
 * BACKSTOP_DENIED_ASSETS set that fires regardless of user prefs.
 */

import { describe, expect, it } from "vitest";
import { assetAllowlist } from "../../src/risk/rules/assetAllowlist";
import type { CanonicalIntent } from "../../src/intent/canonicalIntent";
import type {
    RiskEvaluationContext,
    UserTradingPreferences,
} from "../../src/risk/types";
import { DEFAULT_USER_TRADING_PREFERENCES } from "../../src/risk/types";

const prefs: UserTradingPreferences = {
    ...DEFAULT_USER_TRADING_PREFERENCES,
    userId: "u1",
    updatedAt: new Date().toISOString(),
};

const ctx: RiskEvaluationContext = { preferences: prefs };

function intent(symbol: string): CanonicalIntent {
    return {
        intent_version: 1,
        request_id: "req-1",
        user_id: "u1",
        action: "create_order",
        mode: "live",
        venue: "binance",
        symbol,
        side: "BUY",
        order_type: "market",
        size: { quote_size: "5" },
        idempotency: {
            client_order_id: "test",
            intent_hash: "f".repeat(64),
        },
        policy_context: {},
        locale: "en",
    } as CanonicalIntent;
}

describe("assetAllowlist — platform backstop (QA H-3)", () => {
    it("blocks LUNA-USDT regardless of (empty) user allowlist", () => {
        const ctxEmpty: RiskEvaluationContext = {
            preferences: { ...prefs, asset_allowlist: [], asset_blocklist: [] },
        };
        const r = assetAllowlist(intent("LUNA-USDT"), ctxEmpty);
        expect(r.verdict).toBe("block");
        expect(r.metadata?.reason).toBe("platform_backstop");
        expect(r.explanation).toMatch(/restricted-assets list/i);
    });

    it("blocks LUNA-USDT even when user allowlist explicitly includes LUNA", () => {
        const r = assetAllowlist(intent("LUNA-USDT"), {
            preferences: {
                ...prefs,
                asset_allowlist: ["LUNA", "BTC", "ETH"],
                asset_blocklist: [],
            },
        });
        expect(r.verdict).toBe("block");
        expect(r.metadata?.reason).toBe("platform_backstop");
    });

    it("blocks FTT (post-FTX delisting)", () => {
        const r = assetAllowlist(intent("FTT-USDT"), ctx);
        expect(r.verdict).toBe("block");
        expect(r.metadata?.reason).toBe("platform_backstop");
    });

    it("blocks UST and USTC", () => {
        const r1 = assetAllowlist(intent("UST-USDT"), ctx);
        const r2 = assetAllowlist(intent("USTC-USDT"), ctx);
        expect(r1.verdict).toBe("block");
        expect(r2.verdict).toBe("block");
    });

    it("allows BTC under the default DEFAULT_USER_TRADING_PREFERENCES allowlist", () => {
        const r = assetAllowlist(intent("BTC-USDT"), ctx);
        expect(r.verdict).toBe("allow");
    });

    it("blocks an off-allowlist asset under the new non-empty default", () => {
        const r = assetAllowlist(intent("PEPE-USDT"), ctx);
        expect(r.verdict).toBe("block");
        expect(r.metadata?.allowlist).toContain("BTC");
    });

    it("still allows when the user's allowlist explicitly opts in to a non-backstop asset", () => {
        const r = assetAllowlist(intent("PEPE-USDT"), {
            preferences: {
                ...prefs,
                asset_allowlist: ["BTC", "ETH", "PEPE"],
                asset_blocklist: [],
            },
        });
        expect(r.verdict).toBe("allow");
    });
});
