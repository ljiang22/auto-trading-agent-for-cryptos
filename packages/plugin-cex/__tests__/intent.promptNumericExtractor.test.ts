/**
 * Fix 10 — deterministic numeric extractor tests.
 *
 * Covers:
 *  - EN paired patterns (`Buy 5 BTC`, `Sell 0.5 ETH at $3000`)
 *  - Quote-asset patterns with thousands separators (`5,000 USDT`)
 *  - zh-CN variants (`买 5 BTC`, `100 美元`)
 *  - Empty input
 *  - Cross-check integration (Buy 5 BTC vs LLM base_size=0.05 → divergent)
 */

import { describe, it, expect } from "vitest";
import {
    crossCheckUserIntent,
    extractAssetMentions,
    extractQuantitiesFromPrompt,
} from "../src/intent/promptNumericExtractor";

describe("extractQuantitiesFromPrompt — paired EN", () => {
    it("matches `Buy 5 BTC`", () => {
        const out = extractQuantitiesFromPrompt("Buy 5 BTC");
        expect(out).toEqual([{ value: 5, unit: "base", asset: "BTC" }]);
    });

    it("matches `Sell 0.5 ETH at $3000`", () => {
        const out = extractQuantitiesFromPrompt("Sell 0.5 ETH at $3000");
        // 3000 > 0.5, so the dollar value sorts first.
        expect(out).toEqual([
            { value: 3000, unit: "quote", asset: "USD" },
            { value: 0.5, unit: "base", asset: "ETH" },
        ]);
    });

    it("matches `Buy 5,000 USDT of BTC` with thousands separator", () => {
        const out = extractQuantitiesFromPrompt("Buy 5,000 USDT of BTC");
        // 5000 USDT is the only anchored value; "of BTC" has no number.
        expect(out).toContainEqual({
            value: 5000,
            unit: "quote",
            asset: "USDT",
        });
        // The leading paired entry should be the 5000.
        expect(out[0]).toEqual({ value: 5000, unit: "quote", asset: "USDT" });
    });

    it("matches case-insensitive EN tokens", () => {
        const out = extractQuantitiesFromPrompt("buy 2 btc");
        expect(out).toEqual([{ value: 2, unit: "base", asset: "BTC" }]);
    });
});

describe("extractQuantitiesFromPrompt — zh-CN", () => {
    it("matches `买 5 BTC` (EN code in zh-CN sentence)", () => {
        const out = extractQuantitiesFromPrompt("买 5 BTC");
        expect(out).toEqual([{ value: 5, unit: "base", asset: "BTC" }]);
    });

    it("matches `买 5 比特币` (zh-CN base alias)", () => {
        const out = extractQuantitiesFromPrompt("买 5 比特币");
        expect(out).toEqual([{ value: 5, unit: "base", asset: "BTC" }]);
    });

    it("matches `100 美元` (zh-CN dollar)", () => {
        const out = extractQuantitiesFromPrompt("100 美元");
        // 100 USD anchored.
        expect(out[0]).toEqual({ value: 100, unit: "quote", asset: "USD" });
    });

    it("matches `1000 刀` (zh-CN informal dollar)", () => {
        const out = extractQuantitiesFromPrompt("用 1000 刀买 ETH");
        const dollar = out.find(
            (q) => q.unit === "quote" && q.asset === "USD" && q.value === 1000,
        );
        expect(dollar).toBeDefined();
    });
});

describe("extractQuantitiesFromPrompt — bare numbers and edge cases", () => {
    it("returns [] on empty input", () => {
        expect(extractQuantitiesFromPrompt("")).toEqual([]);
    });

    it("returns [] on null/undefined-ish (defensive cast)", () => {
        expect(extractQuantitiesFromPrompt(undefined as never)).toEqual([]);
        expect(extractQuantitiesFromPrompt(null as never)).toEqual([]);
    });

    it("falls back to unit=unknown for bare numbers", () => {
        const out = extractQuantitiesFromPrompt("place an order for 42");
        // No asset anchor → bare/unknown.
        expect(out).toEqual([{ value: 42, unit: "unknown" }]);
    });

    it("does NOT double-count an anchored token as a bare number", () => {
        const out = extractQuantitiesFromPrompt("Buy 5 BTC");
        // Only the (5, BTC) pair — no extra unknown "5".
        expect(out).toEqual([{ value: 5, unit: "base", asset: "BTC" }]);
    });

    it("drops zero values", () => {
        const out = extractQuantitiesFromPrompt("Buy 0 BTC");
        expect(out).toEqual([]);
    });
});

describe("crossCheckUserIntent — divergence detection", () => {
    it("Buy 5 BTC vs LLM base_size=0.05 → divergent", () => {
        const result = crossCheckUserIntent({
            promptText: "Buy 5 BTC",
            llmBaseSize: "0.05",
        });
        expect(result.divergent).toBe(true);
        expect(result.reason).toBe("divergence_exceeds_threshold");
        expect(result.userValue).toBe(5);
        expect(result.userUnit).toBe("base");
        expect(result.llmValueNormalized).toBe(0.05);
        // 100x off — well above the 5% threshold.
        expect(result.divergenceRatio).toBeGreaterThan(0.5);
    });

    it("Buy 0.05 BTC vs LLM base_size=0.05 → not divergent", () => {
        const result = crossCheckUserIntent({
            promptText: "Buy 0.05 BTC",
            llmBaseSize: "0.05",
        });
        expect(result.divergent).toBe(false);
        expect(result.reason).toBe("within_tolerance");
    });

    it("Buy a little BTC (no number) vs LLM base_size=0.001 → not divergent (no user value)", () => {
        const result = crossCheckUserIntent({
            promptText: "Buy a little BTC",
            llmBaseSize: "0.001",
        });
        expect(result.divergent).toBe(false);
        expect(result.reason).toBe("no_user_anchored_value");
    });

    it("Buy 100 USDT vs LLM quote_size=100 → not divergent (same unit)", () => {
        const result = crossCheckUserIntent({
            promptText: "Buy 100 USDT of BTC",
            llmQuoteSize: "100",
        });
        expect(result.divergent).toBe(false);
        expect(result.reason).toBe("within_tolerance");
    });

    it("Buy 100 USDT vs LLM quote_size=1000 → divergent (same unit, 10x off)", () => {
        const result = crossCheckUserIntent({
            promptText: "Buy 100 USDT of BTC",
            llmQuoteSize: "1000",
        });
        expect(result.divergent).toBe(true);
        expect(result.reason).toBe("divergence_exceeds_threshold");
    });

    it("cross-unit normalization via ticker price (Buy 1 BTC vs LLM quote_size=60000 @ tickerPrice=60000) → not divergent", () => {
        const result = crossCheckUserIntent({
            promptText: "Buy 1 BTC",
            llmQuoteSize: "60000",
            tickerPrice: 60000,
        });
        expect(result.divergent).toBe(false);
        expect(result.reason).toBe("within_tolerance");
    });

    it("cross-unit normalization detects divergence (Buy 1 BTC vs LLM quote_size=600 @ tickerPrice=60000 → 0.01 BTC ≠ 1 BTC)", () => {
        const result = crossCheckUserIntent({
            promptText: "Buy 1 BTC",
            llmQuoteSize: "600",
            tickerPrice: 60000,
        });
        expect(result.divergent).toBe(true);
        expect(result.reason).toBe("divergence_exceeds_threshold");
    });

    it("skips cross-unit comparison when ticker price is missing", () => {
        const result = crossCheckUserIntent({
            promptText: "Buy 5 BTC",
            llmQuoteSize: "1000",
            // no tickerPrice
        });
        expect(result.divergent).toBe(false);
        expect(result.reason).toBe("no_ticker_for_cross_unit");
    });

    it("skips when neither base nor quote size from LLM", () => {
        const result = crossCheckUserIntent({
            promptText: "Buy 5 BTC",
        });
        expect(result.divergent).toBe(false);
        expect(result.reason).toBe("no_llm_size");
    });

    it("zh-CN — `买 5 BTC` vs LLM base_size=0.05 → divergent", () => {
        const result = crossCheckUserIntent({
            promptText: "买 5 BTC",
            llmBaseSize: "0.05",
        });
        expect(result.divergent).toBe(true);
        expect(result.userValue).toBe(5);
    });
});

describe("crossCheckUserIntent — Commit 10 (executablePrice + step tolerance)", () => {
    // Reproduces the staging bug: "place a 10 usdt buy order for
    // btc/usdt with a price of 71000". The LLM emits a base_size
    // rounded to BTC's LOT_SIZE (0.00001), and the previous
    // implementation normalized through the live ticker (~75000)
    // rather than the user-typed limit price (71000), pushing
    // llmValueNormalized to ~10.6 USDT and firing a spurious
    // clarification.
    it("uses executablePrice instead of stale tickerPrice for cross-unit normalization", () => {
        // LLM rounded 10/71000 ≈ 0.0001408 to 0.00014 (LOT_SIZE step 0.00001).
        // With ticker 76000 → 0.00014 * 76000 = 10.64 → divergence 6.4% (>5%, fires).
        // With executablePrice 71000 → 0.00014 * 71000 = 9.94 → divergence 0.6% (passes).
        const result = crossCheckUserIntent({
            promptText: "place a 10 usdt buy order for btc/usdt with a price of 71000",
            llmBaseSize: "0.00014",
            tickerPrice: 76000,
            executablePrice: 71000,
        });
        expect(result.divergent).toBe(false);
    });

    it("falls back to tickerPrice when executablePrice is null", () => {
        const result = crossCheckUserIntent({
            promptText: "Buy 5 BTC",
            llmQuoteSize: "600",
            tickerPrice: 60000,
            executablePrice: null,
        });
        // 5 BTC vs 600/60000 = 0.01 BTC → divergent.
        expect(result.divergent).toBe(true);
    });

    it("widens tolerance by one LOT_SIZE step (baseStepSize)", () => {
        // Without step tolerance: 0.00015 * 71000 = 10.65 vs 10 USDT
        // = 6.1% divergence > 5% threshold → would fire.
        // With baseStepSize=0.00001 and exec price=71000:
        //   stepNoiseFraction ≈ (0.00001 * 71000) / 10.65 = 0.067
        //   effectiveThreshold ≈ 0.05 + 0.067 = 0.117 → passes.
        const result = crossCheckUserIntent({
            promptText: "place 10 usdt buy order for btc",
            llmBaseSize: "0.00015",
            executablePrice: 71000,
            baseStepSize: 0.00001,
        });
        expect(result.divergent).toBe(false);
    });

    it("still fires when the divergence dwarfs the step tolerance", () => {
        // 0.01 BTC * 71000 = 710 USDT vs 10 USDT → 98.6% divergence
        // — step tolerance can't possibly explain it.
        const result = crossCheckUserIntent({
            promptText: "place 10 usdt buy order for btc",
            llmBaseSize: "0.01",
            executablePrice: 71000,
            baseStepSize: 0.00001,
        });
        expect(result.divergent).toBe(true);
        expect(result.reason).toBe("divergence_exceeds_threshold");
    });

    it("caps step-tolerance bump at 25% so it cannot fully disable the check", () => {
        // Pathological step size that would otherwise blow the threshold
        // wide open. The implementation caps at 0.25 fractional.
        // 1.0 BTC * 100 = 100 USDT vs 10 USDT → 90% divergence,
        // still > 0.25 cap → fires.
        const result = crossCheckUserIntent({
            promptText: "place 10 usdt buy order for btc",
            llmBaseSize: "1.0",
            executablePrice: 100,
            baseStepSize: 10,
        });
        expect(result.divergent).toBe(true);
    });
});

describe("extractAssetMentions — Fix 14c", () => {
    it("returns [] for empty input", () => {
        expect(extractAssetMentions("")).toEqual([]);
        expect(extractAssetMentions(undefined as never)).toEqual([]);
        expect(extractAssetMentions(null as never)).toEqual([]);
    });

    it("matches bare EN codes (case-insensitive, word-boundary)", () => {
        expect(extractAssetMentions("Buy BTC now")).toEqual(["BTC"]);
        expect(extractAssetMentions("buy btc and eth")).toEqual(["BTC", "ETH"]);
    });

    it("matches pair-separated forms (BTC-USDT, BTC/USDT)", () => {
        expect(extractAssetMentions("limit on BTC-USDT")).toEqual(["BTC"]);
        expect(extractAssetMentions("ETH/USDT pair please")).toEqual(["ETH"]);
    });

    it("matches pair-concatenated forms (BTCUSDT)", () => {
        expect(extractAssetMentions("track BTCUSDT closely")).toEqual(["BTC"]);
        expect(extractAssetMentions("place an order in ETHUSDT")).toEqual(["ETH"]);
    });

    it("matches zh-CN aliases", () => {
        expect(extractAssetMentions("买入比特币").sort()).toEqual(["BTC"]);
        expect(extractAssetMentions("买点以太坊吧").sort()).toEqual(["ETH"]);
    });

    it("dedupes repeated mentions", () => {
        expect(extractAssetMentions("BTC BTC BTC and 比特币")).toEqual(["BTC"]);
    });

    it("returns multiple distinct assets sorted", () => {
        expect(extractAssetMentions("rotate ETH into SOL")).toEqual(["ETH", "SOL"]);
    });

    it("does not return quote-only tokens", () => {
        // No base asset mentioned — pure quote-currency talk produces []
        // because we only return BASE assets.
        const out = extractAssetMentions("send 100 USDT to me");
        expect(out).not.toContain("USDT");
    });

    it("word-boundary defends against false positives", () => {
        // `MATICAL` should not match `MATIC` (which is in BASE_ASSET_TOKENS).
        expect(extractAssetMentions("the MATICAL theorem")).toEqual([]);
    });
});
