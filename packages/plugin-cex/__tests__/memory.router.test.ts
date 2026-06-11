import { describe, expect, it } from "vitest";

import { routeMemory } from "../src/memory/memoryRouter";
import {
    DEFAULT_USER_TRADING_PREFERENCES,
    type UserTradingPreferences,
} from "../src/risk/types";

function makePrefs(): UserTradingPreferences {
    return {
        userId: "user-1",
        ...DEFAULT_USER_TRADING_PREFERENCES,
        updatedAt: "2026-05-17T00:00:00Z",
    } as UserTradingPreferences;
}

describe("memory router", () => {
    it("injects preferences when referenced (EN)", () => {
        const out = routeMemory({
            messageText: "what are my preferences",
            locale: "en",
            preferences: makePrefs(),
        });
        expect(out.snippets.length).toBe(1);
        expect(out.snippets[0].source).toBe("preferences");
        expect(out.summary).toMatch(/risk_profile/);
    });

    it("injects preferences when referenced (ZH)", () => {
        const out = routeMemory({
            messageText: "我的偏好是什么",
            locale: "zh-CN",
            preferences: makePrefs(),
        });
        expect(out.snippets.length).toBe(1);
        expect(out.summary).toMatch(/[㐀-鿿]/);
    });

    it("ignores preferences if not referenced", () => {
        const out = routeMemory({
            messageText: "buy 0.001 BTC at market",
            locale: "en",
            preferences: makePrefs(),
        });
        expect(out.snippets).toEqual([]);
    });

    it("returns recent trades on history queries", () => {
        const out = routeMemory({
            messageText: "what was my last BTC trade",
            locale: "en",
            recentTrades: [
                {
                    client_order_id: "co-1",
                    venue: "binance",
                    symbol: "BTCUSDT",
                    side: "BUY",
                    state: "filled",
                },
            ],
        });
        expect(out.snippets.length).toBe(1);
        expect(out.snippets[0].source).toBe("recent_trade");
    });

    it("caps recent trades to 3", () => {
        const trades = Array.from({ length: 10 }, (_, i) => ({
            client_order_id: `co-${i}`,
            venue: "binance",
            symbol: "BTCUSDT",
            state: "filled",
        }));
        const out = routeMemory({
            messageText: "show my recent trades",
            locale: "en",
            recentTrades: trades,
        });
        expect(out.snippets.length).toBe(3);
    });

    it("no irrelevant memories on generic query", () => {
        const out = routeMemory({
            messageText: "balance please",
            locale: "en",
            preferences: makePrefs(),
            recentTrades: [
                { client_order_id: "co-1", venue: "binance", state: "filled" },
            ],
        });
        expect(out.snippets).toEqual([]);
    });
});
