import { describe, expect, it } from "vitest";

import {
    detectLocale,
    getLanguageInstruction,
    tagAssistantMemoryLanguage,
} from "../src/utils/languageUtils.ts";
import type { Memory } from "../src/core/types.ts";

describe("detectLocale", () => {
    it("returns 'en' for pure English", () => {
        expect(detectLocale("hello world")).toBe("en");
        expect(detectLocale("Buy 0.01 BTC at market on Binance")).toBe("en");
    });

    it("returns 'zh-CN' for pure Simplified Chinese", () => {
        expect(detectLocale("你好,世界")).toBe("zh-CN");
        expect(detectLocale("我的余额是多少")).toBe("zh-CN");
    });

    it("returns 'zh-CN' when CJK is dominant ≥ 75%", () => {
        // "我的BTC余额是多少" — 7 CJK + 3 latin = 70% CJK → mixed (under threshold)
        // "我的BTC balance是多少" — 6 CJK + 7 latin = 46% — mixed
        // "查询一下BTC余额" — 7 CJK + 3 latin
        const result = detectLocale("查询一下我的BTC");
        // 7 CJK ("查询一下我的") vs 3 latin ("BTC") = 70%, mixed
        // But "查询我的BTC余额今天怎么样啊" → ≥75% CJK
        expect(detectLocale("查询我的BTC余额今天怎么样啊")).toBe("zh-CN");
    });

    it("returns 'en' when Latin is dominant ≥ 75%", () => {
        // "buy 0.01 BTC 在 binance" — 12 latin + 1 CJK ≈ 92% latin
        expect(detectLocale("buy 0.01 BTC 在 binance with limit order please")).toBe("en");
    });

    it("returns 'mixed-en' for near-even mix", () => {
        // ~50/50 mix → mixed-en
        expect(detectLocale("Hi 你好 BTC 价格")).toBe("mixed-en");
    });

    it("returns the fallback for empty / digit-only input", () => {
        expect(detectLocale("")).toBe("en");
        expect(detectLocale("12345")).toBe("en");
        expect(detectLocale("12345", "zh-CN")).toBe("zh-CN");
    });

    it("returns the fallback for emoji-only input", () => {
        expect(detectLocale("🚀🎉💎")).toBe("en");
    });

    it("handles surrogate-pair CJK code points", () => {
        // U+20000 is a CJK Extension B character; encoded as surrogate pair
        expect(detectLocale("\u{20000}\u{20001}\u{20002}")).toBe("zh-CN");
    });

    it("returns the threshold-based answer for boundary cases", () => {
        // Exactly 3 latin + 1 CJK = 75% latin → english side wins
        const text = "abc中";
        expect(detectLocale(text)).toBe("en");
    });
});

describe("getLanguageInstruction", () => {
    it("zero-arg form returns the generic instruction (back-compat)", () => {
        const generic = getLanguageInstruction();
        expect(generic).toMatch(/RESPONSE LANGUAGE/u);
        expect(generic).toMatch(/Detect the language/u);
    });

    it("en form returns the English-specific directive", () => {
        const en = getLanguageInstruction("en");
        expect(en).toMatch(/English/u);
        expect(en).not.toMatch(/Detect the language/u);
    });

    it("zh-CN form returns the Chinese-specific directive", () => {
        const zh = getLanguageInstruction("zh-CN");
        expect(zh).toMatch(/Simplified Chinese|简体中文/u);
    });

    it("mixed-en form acknowledges mixed input + responds EN", () => {
        const mixed = getLanguageInstruction("mixed-en");
        expect(mixed).toMatch(/mix/iu);
        expect(mixed).toMatch(/English/u);
    });

    it("falls back to generic on unknown string", () => {
        const generic = getLanguageInstruction("klingon");
        expect(generic).toMatch(/Detect the language/u);
    });
});

describe("tagAssistantMemoryLanguage", () => {
    it("writes the locale into content.language without mutating the input", () => {
        const memory: Memory = {
            id: "00000000-0000-0000-0000-000000000000" as Memory["id"],
            userId: "u" as Memory["userId"],
            agentId: "a" as Memory["agentId"],
            roomId: "r" as Memory["roomId"],
            content: { text: "hi" },
            createdAt: 0,
        };
        const tagged = tagAssistantMemoryLanguage(memory, "zh-CN");
        expect(tagged.content.language).toBe("zh-CN");
        expect(memory.content.language).toBeUndefined();
    });
});
