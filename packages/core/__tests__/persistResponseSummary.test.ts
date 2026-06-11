import { describe, expect, it } from "vitest";
import { attachResponseSummary } from "../src/utils/persistResponseSummary";
import type { Memory, UUID } from "../src/core/types";

const userId = "11111111-1111-1111-1111-111111111111" as UUID;
const agentId = "22222222-2222-2222-2222-222222222222" as UUID;
const roomId = "33333333-3333-3333-3333-333333333333" as UUID;

const makeMemory = (
    text: string,
    metadata: Record<string, unknown> = {},
): Memory => ({
    id: "44444444-4444-4444-4444-444444444444" as UUID,
    userId: agentId,
    agentId,
    roomId,
    createdAt: Date.now(),
    content: {
        text,
        metadata,
    },
});

describe("attachResponseSummary", () => {
    it("attaches metadata.summary when the body contains a ## Key Findings section", () => {
        const memory = makeMemory(`Body paragraphs here.

## Key Findings
- BTC up 1.4% on the day.
- No funding squeeze.
`);
        const result = attachResponseSummary(memory);
        const summary = (result.content.metadata as { summary?: string }).summary;
        expect(summary).toBeDefined();
        expect(summary).toContain("BTC up 1.4%");
        expect(summary).toContain("No funding squeeze");
    });

    it("is a no-op when the body lacks a recognizable summary section", () => {
        const memory = makeMemory("Plain body with no heading.");
        const result = attachResponseSummary(memory);
        const summary = (result.content.metadata as { summary?: string } | undefined)?.summary;
        expect(summary).toBeUndefined();
    });

    it("is a no-op when the body is empty", () => {
        const memory = makeMemory("");
        const result = attachResponseSummary(memory);
        const summary = (result.content.metadata as { summary?: string } | undefined)?.summary;
        expect(summary).toBeUndefined();
    });

    it("does not overwrite an existing metadata.summary", () => {
        const memory = makeMemory(
            `Body.

## Key Findings
- new summary from prompt.
`,
            { summary: "previously attached" },
        );
        const result = attachResponseSummary(memory);
        const summary = (result.content.metadata as { summary?: string }).summary;
        expect(summary).toBe("previously attached");
    });

    it("uses summaryOverride when supplied, bypassing the extractor", () => {
        const memory = makeMemory("Body with no headings whatsoever.");
        const result = attachResponseSummary(memory, {
            summaryOverride: "- caller-provided summary",
        });
        const summary = (result.content.metadata as { summary?: string }).summary;
        expect(summary).toBe("- caller-provided summary");
    });

    it("ignores an empty summaryOverride and falls back to extraction", () => {
        const memory = makeMemory(`Body.

## Key Findings
- extracted summary.
`);
        const result = attachResponseSummary(memory, {
            summaryOverride: "   ",
        });
        const summary = (result.content.metadata as { summary?: string }).summary;
        // empty override returns "" → no attach (the override path requires
        // a truthy trimmed string OR the extractor finds the section)
        expect(summary).toContain("extracted summary");
    });

    it("preserves the original memory object (does not mutate)", () => {
        const memory = makeMemory(`Body.

## Key Findings
- summary.
`);
        const before = JSON.stringify(memory);
        attachResponseSummary(memory);
        const after = JSON.stringify(memory);
        expect(after).toBe(before);
    });

    it("is idempotent: a second call with no override does not duplicate the summary", () => {
        const memory = makeMemory(`Body.

## Key Findings
- summary.
`);
        const first = attachResponseSummary(memory);
        const second = attachResponseSummary(first);
        const firstSummary = (first.content.metadata as { summary?: string }).summary;
        const secondSummary = (second.content.metadata as { summary?: string }).summary;
        expect(firstSummary).toBe(secondSummary);
    });

    it("preserves other metadata keys", () => {
        const memory = makeMemory(
            `Body.

## Key Findings
- summary.
`,
            { existing: "value", number: 42 },
        );
        const result = attachResponseSummary(memory);
        const metadata = result.content.metadata as Record<string, unknown>;
        expect(metadata.existing).toBe("value");
        expect(metadata.number).toBe(42);
        expect(typeof metadata.summary).toBe("string");
    });

    // Sanity check that the userId import is exercised (avoids `unused` warning
    // under strict modes).
    it("uses agent-shaped Memory fixtures", () => {
        const memory = makeMemory("test", {});
        expect(memory.userId).not.toBe(userId);
    });
});
