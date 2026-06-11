import { describe, expect, it } from "vitest";
import {
    extractExecutiveSummaryFromMarkdown,
    extractResponseSummary,
} from "../src/utils/executiveSummaryFromMarkdown";

describe("extractExecutiveSummaryFromMarkdown (back-compat)", () => {
    it("extracts the body under ### N. Executive Summary", () => {
        const md = `# BTC Daily Report

### 1. Executive Summary
BTC closed at $78,140, **up 1.4%**.

### 2. Technical
RSI 62, MACD bullish crossover.
`;
        const summary = extractExecutiveSummaryFromMarkdown(md);
        expect(summary).toContain("BTC closed at $78,140");
        expect(summary).not.toContain("RSI 62");
    });

    it("returns an empty string when no section is present", () => {
        const md = "# BTC Daily Report\n\nNothing here.\n";
        expect(extractExecutiveSummaryFromMarkdown(md)).toBe("");
    });

    it("falls back to the EXEC_SUMMARY marker block", () => {
        const md = `Some body
<!-- EXEC_SUMMARY_START -->
Markers carry the body when the heading is missing.
<!-- EXEC_SUMMARY_END -->
`;
        const summary = extractExecutiveSummaryFromMarkdown(md);
        expect(summary).toContain("Markers carry the body");
    });

    it("supports the Simplified Chinese heading variant 执行摘要", () => {
        const md = `### 1. 执行摘要
BTC 收于 $78,140，**上涨 1.4%**。

### 2. 技术
RSI 62
`;
        const summary = extractExecutiveSummaryFromMarkdown(md);
        expect(summary).toContain("BTC 收于 $78,140");
        expect(summary).not.toContain("RSI 62");
    });
});

describe("extractResponseSummary (generic)", () => {
    it("extracts the body under ## Key Findings", () => {
        const md = `Here is my full analysis. Lots of paragraphs.

## Key Findings
- BTC up 1.4% to $78,140.
- Funding flat, no leverage flush.
`;
        const summary = extractResponseSummary(md);
        expect(summary).toContain("BTC up 1.4%");
        expect(summary).toContain("Funding flat");
    });

    it("recognizes ## Summary", () => {
        const md = `Body.

## Summary
- One bullet only.
`;
        expect(extractResponseSummary(md)).toContain("One bullet only");
    });

    it("recognizes ## TL;DR", () => {
        const md = `Body.

## TL;DR
- punchline.
`;
        expect(extractResponseSummary(md)).toContain("punchline");
    });

    it("recognizes the zh-CN heading 关键发现", () => {
        const md = `分析正文。

## 关键发现
- BTC 收于 78140 美元。
`;
        expect(extractResponseSummary(md)).toContain("BTC 收于 78140");
    });

    it("recognizes 总结 and 摘要", () => {
        const md1 = `Body.\n\n## 总结\n- 概要点。`;
        const md2 = `Body.\n\n## 摘要\n- 概要点。`;
        expect(extractResponseSummary(md1)).toContain("概要点");
        expect(extractResponseSummary(md2)).toContain("概要点");
    });

    it("falls back to the KEY_FINDINGS marker block", () => {
        const md = `Body.
<!-- KEY_FINDINGS_START -->
Markers carry the bullets when the heading is missing.
<!-- KEY_FINDINGS_END -->
`;
        expect(extractResponseSummary(md)).toContain("Markers carry the bullets");
    });

    it("still recognizes the older EXEC_SUMMARY marker block", () => {
        const md = `Body.
<!-- EXEC_SUMMARY_START -->
Legacy marker carries through.
<!-- EXEC_SUMMARY_END -->
`;
        expect(extractResponseSummary(md)).toContain("Legacy marker");
    });

    it("returns an empty string when no Key Findings / Summary / TL;DR is present", () => {
        const md = "Plain body without any summary heading.\n";
        expect(extractResponseSummary(md)).toBe("");
    });

    it("trims to the 800-char default cap", () => {
        const longBody = "- bullet\n".repeat(500);
        const md = `Body.\n\n## Key Findings\n${longBody}`;
        const result = extractResponseSummary(md);
        expect(result.length).toBeLessThanOrEqual(800);
        // Truncation marker appended.
        expect(result.endsWith("…")).toBe(true);
    });

    it("honors a custom maxChars cap", () => {
        const md = `Body.

## Key Findings
- bullet one
- bullet two
- bullet three
`;
        const result = extractResponseSummary(md, 20);
        expect(result.length).toBeLessThanOrEqual(20);
    });

    it("matches a bold pseudo-heading when ATX is absent", () => {
        const md = `Body.

**Key Findings**
- bullet via bold pseudo-heading.
`;
        expect(extractResponseSummary(md)).toContain("bold pseudo-heading");
    });
});
