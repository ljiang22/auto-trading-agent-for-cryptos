import { describe, expect, it } from "vitest";

import { compileNlToDsl } from "../src/strategy/nlToDSL";
import { runStrategyOnce } from "../src/strategy/strategyRuntime";
import type { StrategyDSL } from "../src/strategy/strategyDSL";

function makeRsiStrategy(): StrategyDSL {
    const r = compileNlToDsl(
        "RSI 30/70 mean-revert on BTC hourly",
        { locale: "en", owner: "user-1", venue: "binance" },
    );
    if (!r.ok) throw new Error("compilation failed");
    return r.strategy;
}

describe("Strategy runtime", () => {
    it("fires entry when rsi14 < 30", () => {
        const trigger = runStrategyOnce({
            strategy: makeRsiStrategy(),
            context: { signals: { rsi14: 25 }, equityUsd: 10_000, midPrice: 70_000 },
            userId: "user-1",
            locale: "en",
        });
        expect(trigger.kind).toBe("entry");
        if (trigger.kind === "entry") {
            expect(trigger.intent.action).toBe("create_order");
            expect(trigger.intent.side).toBe("BUY");
            expect(trigger.intent.order_type).toBe("limit");
        }
    });

    it("fires exit when rsi14 > 70", () => {
        const trigger = runStrategyOnce({
            strategy: makeRsiStrategy(),
            context: { signals: { rsi14: 80 }, equityUsd: 10_000, midPrice: 70_000 },
            userId: "user-1",
            locale: "en",
        });
        expect(trigger.kind).toBe("exit");
        if (trigger.kind === "exit") {
            expect(trigger.intent.side).toBe("SELL");
        }
    });

    it("returns noop when no rule matches", () => {
        const trigger = runStrategyOnce({
            strategy: makeRsiStrategy(),
            context: { signals: { rsi14: 50 }, equityUsd: 10_000, midPrice: 70_000 },
            userId: "user-1",
            locale: "en",
        });
        expect(trigger.kind).toBe("noop");
    });

    it("modeOverride propagates to intent", () => {
        const trigger = runStrategyOnce({
            strategy: makeRsiStrategy(),
            context: { signals: { rsi14: 25 }, equityUsd: 10_000, midPrice: 70_000 },
            userId: "user-1",
            locale: "en",
            modeOverride: "paper",
        });
        if (trigger.kind === "entry") {
            expect(trigger.intent.mode).toBe("paper");
        }
    });
});
