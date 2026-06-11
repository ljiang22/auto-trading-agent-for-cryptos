import { describe, expect, it } from "vitest";

import {
    inferStakeHint,
    parseExecutionModePrefix,
    preprocess,
} from "../src/handlers/cexRequestPreprocess.ts";
import {
    findVenueMentionInText,
    matchVenueToken,
} from "../src/handlers/cexVenueAliases.ts";

type Venue = "binance" | "coinbase";

const matchers = {
    matchToken: matchVenueToken as (t: string) => Venue | null,
    findMentionInText: findVenueMentionInText as (t: string) => Venue | null,
};

describe("inferStakeHint", () => {
    it("classifies 'show my balance' as read_only", () => {
        expect(inferStakeHint("show my BTC balance")).toBe("read_only");
    });

    it("classifies 'buy 0.01 BTC' as write", () => {
        expect(inferStakeHint("buy 0.01 BTC at market")).toBe("write");
    });

    it("classifies '取消订单' as write (Chinese cancel)", () => {
        expect(inferStakeHint("取消订单 12345")).toBe("write");
    });

    it("classifies '查询余额' as read_only (Chinese balance query)", () => {
        expect(inferStakeHint("查询我的余额")).toBe("read_only");
    });

    it("returns 'unknown' for ambiguous text", () => {
        expect(inferStakeHint("hello there friend")).toBe("unknown");
    });

    it("treats mixed signals as write (write keyword wins)", () => {
        expect(inferStakeHint("show me and buy 0.001 BTC")).toBe("write");
    });
});

describe("preprocess (full pipeline)", () => {
    it("read-only balance EN → locale=en, stake=read_only, resolved=default", () => {
        const out = preprocess<Venue>({
            messageText: "show my BTC balance on Binance",
            recentMemories: [],
            configuredVenues: ["binance", "coinbase"],
            defaultVenue: "coinbase",
            stakeHint: "read_only",
            ...matchers,
        });
        expect(out.locale).toBe("en");
        expect(out.stake).toBe("read_only");
        expect(out.exchange_resolution.kind).toBe("resolved");
        if (out.exchange_resolution.kind === "resolved") {
            // explicit mention wins
            expect(out.exchange_resolution.venue).toBe("binance");
            expect(out.exchange_resolution.source).toBe("message");
        }
    });

    it("write ZH no signal 2+ venues → clarification, locale=zh-CN", () => {
        // CJK-dominant Chinese message (no Latin tokens): "我想买入比特币市价单"
        const out = preprocess<Venue>({
            messageText: "我想买入比特币市价单",
            recentMemories: [],
            configuredVenues: ["binance", "coinbase"],
            stakeHint: "write",
            ...matchers,
        });
        expect(out.locale).toBe("zh-CN");
        expect(out.stake).toBe("write");
        expect(out.exchange_resolution.kind).toBe("needs_clarification");
    });

    it("mixed-en treated as en for clarification text language", () => {
        const out = preprocess<Venue>({
            messageText: "Buy 0.01 BTC 在交易所",
            recentMemories: [],
            configuredVenues: ["binance", "coinbase"],
            stakeHint: "write",
            ...matchers,
        });
        // Latin-leaning balanced input
        expect(["en", "mixed-en"]).toContain(out.locale);
    });

    it("preferredLanguage fallback applies only when input has no alpha", () => {
        const out1 = preprocess<Venue>({
            messageText: "12345",
            recentMemories: [],
            configuredVenues: ["binance"],
            defaultVenue: "binance",
            preferredLanguage: "zh-CN",
            stakeHint: "read_only",
            ...matchers,
        });
        expect(out1.locale).toBe("zh-CN");
        const out2 = preprocess<Venue>({
            messageText: "show balance",
            recentMemories: [],
            configuredVenues: ["binance"],
            defaultVenue: "binance",
            preferredLanguage: "zh-CN",
            stakeHint: "read_only",
            ...matchers,
        });
        // Non-empty alpha wins over fallback
        expect(out2.locale).toBe("en");
    });

    it("unknown stakeHint defaults to write (fail-closed) → forces clarification when 2 venues", () => {
        const out = preprocess<Venue>({
            messageText: "BTC?",
            recentMemories: [],
            configuredVenues: ["binance", "coinbase"],
            stakeHint: "unknown",
            ...matchers,
        });
        expect(out.stake).toBe("write");
        expect(out.exchange_resolution.kind).toBe("needs_clarification");
    });
});

// C3 — per-message execution-mode prefix override. The QA repro:
// "paper mode: place a limit buy order …" with default_mode=live was
// classified as `stake:"live"` because the LLM never extracted the
// prefix into `params.mode`. The fix parses the prefix in
// `cexRequestPreprocess` so the resolved mode is set BEFORE the risk
// gate has any chance to stamp the wrong value.
describe("C3 parseExecutionModePrefix", () => {
    it("returns 'paper' for 'paper mode: …'", () => {
        expect(parseExecutionModePrefix("paper mode: buy 0.001 BTC")).toBe("paper");
    });
    it("returns 'live' for 'live mode: …'", () => {
        expect(parseExecutionModePrefix("live mode: buy 0.001 BTC")).toBe("live");
    });
    it("returns 'shadow' for 'shadow mode: …'", () => {
        expect(parseExecutionModePrefix("shadow mode: place a limit")).toBe("shadow");
    });
    it("tolerates leading whitespace + quotes", () => {
        expect(parseExecutionModePrefix("  paper mode: x")).toBe("paper");
        expect(parseExecutionModePrefix(`"paper mode: x`)).toBe("paper");
    });
    it("is case-insensitive (EN)", () => {
        expect(parseExecutionModePrefix("PAPER MODE: x")).toBe("paper");
        expect(parseExecutionModePrefix("Paper Mode: x")).toBe("paper");
    });
    it("accepts zh-CN equivalents", () => {
        expect(parseExecutionModePrefix("纸面模式: 买 0.001 BTC")).toBe("paper");
        expect(parseExecutionModePrefix("实盘模式: 买 0.001 BTC")).toBe("live");
        expect(parseExecutionModePrefix("影子模式: 买 0.001 BTC")).toBe("shadow");
    });
    it("accepts the full-width colon variant", () => {
        expect(parseExecutionModePrefix("paper mode：buy 0.001 BTC")).toBe("paper");
        expect(parseExecutionModePrefix("纸面模式：买 0.001 BTC")).toBe("paper");
    });
    it("returns null when the phrase is deep inside the text (not a prefix)", () => {
        // QA-critical: prevents "compared with paper mode: …" from
        // hijacking the request mode.
        expect(parseExecutionModePrefix("compared with paper mode: x")).toBe(null);
    });
    it("returns null on the empty string", () => {
        expect(parseExecutionModePrefix("")).toBe(null);
    });
    it("returns null for unrelated mode words", () => {
        expect(parseExecutionModePrefix("turbo mode: x")).toBe(null);
        expect(parseExecutionModePrefix("dark mode: x")).toBe(null);
    });
});

describe("C3 preprocess.mode_override", () => {
    it("plumbs the prefix-parsed mode into the preprocess output", () => {
        const out = preprocess<Venue>({
            messageText: "paper mode: buy 0.001 BTC",
            recentMemories: [],
            configuredVenues: ["binance"],
            defaultVenue: "binance",
            stakeHint: "write",
            ...matchers,
        });
        expect(out.mode_override).toBe("paper");
    });
    it("returns null mode_override when no prefix is present", () => {
        const out = preprocess<Venue>({
            messageText: "buy 0.001 BTC",
            recentMemories: [],
            configuredVenues: ["binance"],
            defaultVenue: "binance",
            stakeHint: "write",
            ...matchers,
        });
        expect(out.mode_override).toBe(null);
    });
});
