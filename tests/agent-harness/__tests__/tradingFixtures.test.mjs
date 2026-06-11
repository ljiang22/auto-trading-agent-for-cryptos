import { describe, expect, it } from "vitest";
import {
    NOTIONAL_USDT,
    baseSizeFor6Usdt,
    buildCreateOrderCompose,
    buildCreateOrderNlText,
    buildCancelOrderCompose,
    buildCancelOrderNlText,
    buildGetOrdersCompose,
    buildHarnessOrderRecord,
    buildOrderConfiguration,
    buildPriceLadderFromMid,
    formatUsdtPrice,
    mirrorNlCase,
    pickAlternatingVenueCase,
    toImplicitPrompt,
    catalogEntryToCase,
    BINANCE_SUPPORTED_VARIANTS,
    BINANCE_UNSUPPORTED_VARIANTS,
} from "../lib/tradingFixtures.mjs";
import { createTranscriptState } from "../lib/transcript.mjs";
import { getCatalogEntries } from "../suites/trading-prod/trading-prod-catalog.mjs";

describe("tradingFixtures", () => {
    it("computes ~6 USDT base size", () => {
        expect(baseSizeFor6Usdt(100_000)).toBe("0.00006");
    });

    it("market IOC uses 6 USDT quote", () => {
        const oc = buildOrderConfiguration("market_market_ioc");
        expect(oc.market_market_ioc.quote_size).toBe("6.00");
    });

    it("buildCreateOrderCompose sets live mode", () => {
        const compose = buildCreateOrderCompose({
            variant: "market_market_ioc",
            caseId: "t1",
        });
        expect(compose.params.mode).toBe("live");
        expect(compose.params.product_id).toBe("BTC-USDT");
    });

    it("buildCancelOrderCompose sets all_open", () => {
        const compose = buildCancelOrderCompose({ caseId: "c1" });
        expect(compose.action).toBe("cancel_order");
        expect(compose.params.all_open).toBe(true);
        expect(compose.params.product_id).toBe("BTC-USDT");
    });

    it("buildCancelOrderCompose targets specific order_ids", () => {
        const compose = buildCancelOrderCompose({
            caseId: "teardown",
            allOpen: false,
            orderIds: ["111", "222"],
        });
        expect(compose.params.all_open).toBe(false);
        expect(compose.params.order_ids).toEqual(["111", "222"]);
        expect(compose.previewText).toMatch(/cancel.*111.*222/i);
    });

    it("buildCreateOrderNlText uses canonical vocabulary not variant keys", () => {
        for (const variant of [
            ...BINANCE_SUPPORTED_VARIANTS,
            ...BINANCE_UNSUPPORTED_VARIANTS,
        ]) {
            const side =
                variant.includes("oco") || variant.includes("trailing") ? "SELL" : "BUY";
            const nl = buildCreateOrderNlText({ variant, side });
            expect(nl).not.toMatch(/limit_limit_gtc|market_market_ioc|stop_limit_stop/);
            expect(nl).toMatch(/buy|sell/i);
            expect(nl).toMatch(/BTC-USDT|BTC/);
        }
    });

    it("buildCreateOrderCompose previewText matches NL builder", () => {
        const compose = buildCreateOrderCompose({
            variant: "limit_limit_gtc",
            caseId: "t1",
        });
        expect(compose.previewText).toBe(
            buildCreateOrderNlText({ variant: "limit_limit_gtc", side: "BUY" }),
        );
        expect(compose.previewText).toMatch(/limit/i);
    });

    it("buildCancelOrderNlText all_open mentions cancel", () => {
        const nl = buildCancelOrderNlText({ allOpen: true });
        expect(nl).toMatch(/cancel all open/i);
    });

    it("buildGetOrdersCompose sets product_ids", () => {
        const compose = buildGetOrdersCompose({ marginType: "CROSS" });
        expect(compose.action).toBe("get_orders");
        expect(compose.params.product_ids).toEqual(["BTC-USDT"]);
        expect(compose.params.margin_type).toBe("CROSS");
    });

    it("buildHarnessOrderRecord tracks harness create_order cases", () => {
        const compose = buildCreateOrderCompose({
            variant: "limit_limit_gtc",
            caseId: "spot-limit_limit_gtc",
        });
        const record = buildHarnessOrderRecord(
            {
                id: "spot-limit_limit_gtc",
                roomGroup: "spot",
                compose,
            },
            createTranscriptState(),
        );
        expect(record?.clientOrderId).toMatch(/^harness-spot-limit_limit_gtc-/);
        expect(record?.roomGroup).toBe("spot");
    });

    it("toImplicitPrompt strips Binance", () => {
        expect(toImplicitPrompt("Using Binance, list my open orders")).toBe(
            "list my open orders",
        );
    });

    it("mirrorNlCase emits explicit and implicit twins", () => {
        const twins = mirrorNlCase({
            id: "ro-balance",
            message: { text: "Using Binance, show balances" },
            tags: ["read_only"],
        });
        expect(twins).toHaveLength(2);
        expect(twins[0].id).toBe("ro-balance");
        expect(twins[1].id).toBe("ro-balance-implicit");
        expect(twins[1].message.text).not.toMatch(/binance/i);
    });

    it("pickAlternatingVenueCase picks explicit on even index", () => {
        const chosen = pickAlternatingVenueCase(
            {
                id: "ro-balance",
                title: "Spot + margin balances",
                message: { text: "Using Binance, show balances" },
                tags: ["read_only"],
            },
            0,
        );
        expect(chosen.id).toBe("ro-balance");
        expect(chosen.title).toBe("Spot + margin balances");
        expect(chosen.tags).toContain("explicit_venue");
        expect(chosen.message.text).toMatch(/binance/i);
    });

    it("pickAlternatingVenueCase picks implicit on odd index", () => {
        const chosen = pickAlternatingVenueCase(
            {
                id: "ro-orders",
                title: "Open orders",
                message: { text: "Using Binance, list my open orders" },
                tags: ["read_only"],
            },
            1,
        );
        expect(chosen.id).toBe("ro-orders");
        expect(chosen.title).toBe("Open orders");
        expect(chosen.tags).toContain("implicit_venue");
        expect(chosen.message.text).not.toMatch(/binance/i);
    });

    it("pickAlternatingVenueCase falls back to explicit when mirroring disabled", () => {
        const chosen = pickAlternatingVenueCase(
            {
                id: "x",
                message: { text: "Using Binance, hello" },
                mirror: false,
            },
            1,
        );
        expect(chosen.tags).toContain("explicit_venue");
        expect(chosen.id).toBe("x");
    });

    it("spot anchor cases use canonical NL for market IOC and limit GTC", () => {
        const entries = getCatalogEntries();
        const marketIdx = entries.findIndex((e) => e.id === "spot-market_market_ioc");
        const limitIdx = entries.findIndex((e) => e.id === "spot-limit_limit_gtc");
        expect(marketIdx).toBeGreaterThanOrEqual(0);
        expect(limitIdx).toBeGreaterThanOrEqual(0);

        const marketCase = pickAlternatingVenueCase(
            catalogEntryToCase(entries[marketIdx]),
            marketIdx,
        );
        const limitCase = pickAlternatingVenueCase(
            catalogEntryToCase(entries[limitIdx]),
            limitIdx,
        );

        expect(marketCase.message.text).toBe(
            "buy $6.00 of BTC-USDT at market.",
        );
        expect(marketCase.tags).toContain("implicit_venue");

        const mid = 60_000;
        const ladder = buildPriceLadderFromMid(mid);
        const limitNl = buildCreateOrderNlText({
            variant: "limit_limit_gtc",
            side: "BUY",
            marketMid: mid,
            priceLadder: ladder,
        });
        expect(limitCase.tags).toContain("explicit_venue");
        expect(limitNl).toContain(ladder.buyLimit);
        expect(limitNl).toMatch(/limit GTC/i);
        expect(ladder.buyLimit).toBe(formatUsdtPrice(mid));
    });

    it("catalogEntryToCase maps nl to message", () => {
        const c = catalogEntryToCase({
            id: "x",
            roomGroup: "spot",
            nl: { text: "hello" },
            expect: { pass: true },
        });
        expect(c.message.text).toBe("hello");
    });

    it("lists binance variant sets", () => {
        expect(BINANCE_SUPPORTED_VARIANTS).toContain("market_market_ioc");
        expect(BINANCE_UNSUPPORTED_VARIANTS).toContain("market_market_fok");
        expect(NOTIONAL_USDT).toBe(6);
    });
});
