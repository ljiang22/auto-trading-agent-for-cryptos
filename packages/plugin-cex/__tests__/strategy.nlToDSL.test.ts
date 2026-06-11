import { describe, expect, it } from "vitest";

import { compileNlToDsl } from "../src/strategy/nlToDSL";

describe("NL → DSL compiler (heuristic)", () => {
    it("DCA daily BTC at $50", () => {
        const r = compileNlToDsl("DCA $50 BTC daily", {
            locale: "en",
            owner: "user-1",
            venue: "binance",
        });
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.strategy.identity.id).toContain("dca");
            expect(r.strategy.universe.venue).toBe("binance");
            expect(r.strategy.universe.symbols[0]).toBe("BTC-USDT");
            expect(r.strategy.operations.evaluation_interval_seconds).toBe(86400);
        }
    });

    it("DCA weekly $100 BTC on Coinbase", () => {
        const r = compileNlToDsl("DCA $100 BTC weekly", {
            locale: "en",
            owner: "user-1",
            venue: "coinbase",
        });
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.strategy.universe.symbols[0]).toBe("BTC-USD");
            expect(r.strategy.operations.evaluation_interval_seconds).toBe(7 * 86400);
        }
    });

    it("RSI 30/70 mean-revert on ETH", () => {
        const r = compileNlToDsl(
            "RSI 30/70 mean-revert on ETH hourly",
            { locale: "en", owner: "user-1", venue: "binance" },
        );
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.strategy.identity.id).toContain("rsi-meanrevert-eth");
            const entryWhen = r.strategy.entries[0].when;
            expect(entryWhen.op).toBe("lt");
        }
    });

    it("ZH: DCA 每周 BTC $50", () => {
        const r = compileNlToDsl("每周 DCA $50 BTC", {
            locale: "zh-CN",
            owner: "user-1",
            venue: "binance",
        });
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.strategy.operations.evaluation_interval_seconds).toBe(7 * 86400);
        }
    });

    it("clarifies on unknown strategy", () => {
        const r = compileNlToDsl(
            "make me a strategy that does something cool",
            { locale: "en", owner: "user-1", venue: "binance" },
        );
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.needsClarification).toBe(true);
            expect(r.text).toMatch(/classify|clarify/i);
        }
    });

    it("ZH clarification copy", () => {
        const r = compileNlToDsl(
            "做一个特别的策略",
            { locale: "zh-CN", owner: "user-1", venue: "binance" },
        );
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.text).toMatch(/[㐀-鿿]/);
        }
    });
});
