import { describe, expect, it } from "vitest";

import { buildCanonicalIntent } from "../src/intent/intentBuilder";
import {
    buildShadowDecisionRecord,
    computeDivergenceRatio,
    createInMemoryShadowDecisionWriter,
} from "../src/strategy/shadowDecisions";

function makeIntent() {
    return buildCanonicalIntent({
        action: "create_order",
        venue: "binance",
        userId: "user-1",
        locale: "en",
        mode: "shadow",
        params: {
            userId: "user-1" as never,
            product_id: "BTCUSDT",
            side: "BUY",
            order_configuration: {
                market_market_ioc: { base_size: "0.01" },
            },
        },
    });
}

describe("Shadow decisions", () => {
    it("buildShadowDecisionRecord projects from intent", () => {
        const intent = makeIntent();
        const rec = buildShadowDecisionRecord({
            intent,
            decision: "allow",
            rules_fired: [],
            market_mid_price: "70000",
        });
        expect(rec.intent_hash).toBe(intent.idempotency.intent_hash);
        expect(rec.venue).toBe("binance");
        expect(rec.decision).toBe("allow");
        expect(rec.paper_divergence).toBeUndefined();
    });

    it("detects divergence when paper differs from shadow", () => {
        const intent = makeIntent();
        const rec = buildShadowDecisionRecord({
            intent,
            decision: "allow",
            rules_fired: [],
            paper_decision: "block",
        });
        expect(rec.paper_divergence).toBe(true);
    });

    it("agrees when paper matches shadow", () => {
        const intent = makeIntent();
        const rec = buildShadowDecisionRecord({
            intent,
            decision: "allow",
            rules_fired: [],
            paper_decision: "allow",
        });
        expect(rec.paper_divergence).toBe(false);
    });

    it("in-memory writer collects records", async () => {
        const w = createInMemoryShadowDecisionWriter();
        const intent = makeIntent();
        await w.record(
            buildShadowDecisionRecord({
                intent,
                decision: "allow",
                rules_fired: [],
            }),
        );
        expect(w.records).toHaveLength(1);
    });

    it("computeDivergenceRatio", () => {
        const intent = makeIntent();
        const records = [
            buildShadowDecisionRecord({
                intent,
                decision: "allow",
                rules_fired: [],
                paper_decision: "allow",
            }),
            buildShadowDecisionRecord({
                intent,
                decision: "allow",
                rules_fired: [],
                paper_decision: "block",
            }),
            buildShadowDecisionRecord({
                intent,
                decision: "allow",
                rules_fired: [],
                paper_decision: "allow",
            }),
            buildShadowDecisionRecord({
                intent,
                decision: "allow",
                rules_fired: [],
                paper_decision: "allow",
            }),
        ];
        expect(computeDivergenceRatio(records)).toBeCloseTo(0.25, 5);
    });

    it("computeDivergenceRatio is 0 when no records", () => {
        expect(computeDivergenceRatio([])).toBe(0);
    });
});
