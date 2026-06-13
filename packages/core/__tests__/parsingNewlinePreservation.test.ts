import { describe, it, expect } from "vitest";
import {
    parseJSONObjectFromText,
    extractAttributes,
} from "../src/validation/parsing";

// Multi-paragraph markdown like generateMessageResponse produces for long answers.
// Block-level markdown (headings, lists) only renders when newlines survive parsing.
const MARKDOWN_TEXT = [
    "It's understandable to feel unsure about the right time to invest.",
    "",
    "### Current Bitcoin Market Overview",
    "",
    "*   **Current Price**: Approximately $63,433.44 USD per Bitcoin.",
    "*   **24-Hour Change**: Up 2.80%.",
    "",
    "1.  **Volatility**: Bitcoin is known for significant price swings.",
    "2.  **Market Timing is Difficult**: Consider Dollar-Cost Averaging.",
].join("\n");

describe("parseJSONObjectFromText newline preservation", () => {
    it("preserves newlines when the model emits raw newlines inside the JSON string value", () => {
        // Strictly invalid JSON (raw control chars in a string) but the most
        // common LLM output shape for long markdown answers.
        const input = `\`\`\`json\n{ "user": "CryptoTrader", "text": "${MARKDOWN_TEXT}", "action": "NONE" }\n\`\`\``;

        const parsed = parseJSONObjectFromText(input);

        expect(parsed).not.toBeNull();
        expect(parsed?.text).toBe(MARKDOWN_TEXT);
        expect(parsed?.user).toBe("CryptoTrader");
        expect(parsed?.action).toBe("NONE");
    });

    it("preserves newlines when the model escapes them properly (valid JSON)", () => {
        const valid = JSON.stringify(
            { user: "CryptoTrader", text: MARKDOWN_TEXT, action: "NONE" },
            null,
            2
        );
        const input = `\`\`\`json\n${valid}\n\`\`\``;

        const parsed = parseJSONObjectFromText(input);

        expect(parsed?.text).toBe(MARKDOWN_TEXT);
    });

    it("preserves newlines for unfenced JSON objects containing raw newlines", () => {
        const input = '{ "text": "line one\nline two" }';

        expect(parseJSONObjectFromText(input)?.text).toBe(
            "line one\nline two"
        );
    });

    it("still parses plain valid JSON objects", () => {
        expect(parseJSONObjectFromText('{"key": "value"}')).toEqual({
            key: "value",
        });
        expect(
            parseJSONObjectFromText('```json\n{"key": "value"}\n```')
        ).toEqual({ key: "value" });
        expect(parseJSONObjectFromText("{}")).toEqual({});
    });

    it("still parses JSON objects containing array values", () => {
        expect(
            parseJSONObjectFromText('{"key": ["item1", "item2"]}')
        ).toEqual({ key: ["item1", "item2"] });
    });

    it("returns null for non-JSON input", () => {
        expect(parseJSONObjectFromText("invalid")).toBe(null);
    });
});

describe("extractAttributes escaped-content handling", () => {
    it("does not truncate values at escaped quotes and unescapes JSON escapes", () => {
        const response =
            '{ "user": "Agent", "text": "He said \\"hello\\" and left.\\nBye." }';

        const attrs = extractAttributes(response, ["text"]);

        expect(attrs?.text).toBe('He said "hello" and left.\nBye.');
    });

    it("extracts all attributes with escaped quotes intact", () => {
        const response =
            '{ "user": "Agent", "text": "A \\"quoted\\" word" }';

        const attrs = extractAttributes(response);

        expect(attrs?.user).toBe("Agent");
        expect(attrs?.text).toBe('A "quoted" word');
    });
});
